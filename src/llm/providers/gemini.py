"""Gemini provider adapter - Hardened Parity Version."""

from __future__ import annotations

import logging
import os
from typing import Any
import json

logger = logging.getLogger(__name__)

try:
    from google import genai
    from google.genai import types
    from google.genai.errors import APIError
except ImportError:
    genai = None
    types = None
    APIError = Exception

from llm.core.interface import (
    AuthenticationError,
    ContextLengthError,
    LLMProvider,
    RateLimitError,
    ToolExecutionError,
    LLMError
)
from llm.core.types import LLMInput, LLMOutput, Message, ModelInfo, ProviderType, ToolCall, ToolDefinition
from llm.core.model_resolver import ModelResolver


class GeminiProvider(LLMProvider):
    provider_type = ProviderType.GEMINI

    def __init__(self, api_key: str | None = None, **kwargs: Any) -> None:
        if genai is None:
            raise ImportError("google-genai package is required to use GeminiProvider")
        
        key = api_key or os.environ.get("GEMINI_API_KEY")
        if not key:
            raise AuthenticationError("No Gemini API key provided", provider=ProviderType.GEMINI)

        self.client = genai.Client(api_key=key)

        # Model routing is fully dynamic: defaults, fallbacks and the model
        # catalogue all come from the centralized ModelResolver. No model ID
        # is hardcoded in the provider itself.
        self._default_model = ModelResolver.default_model("gemini")
        self._fallback_chain = ModelResolver.fallback_map(self._default_model)
        self._models = ModelResolver.model_infos("gemini")

    def _map_tools(self, tools: list[ToolDefinition] | None) -> list[types.Tool] | None:
        if not tools:
            return None
        
        declarations = []
        for tool in tools:
            schema = tool.parameters
            
            def build_schema(schema_dict: dict[str, Any]) -> types.Schema:
                schema_type_str = schema_dict.get("type", "STRING").upper()
                if schema_type_str == "OBJECT":
                    schema_type = types.Type.OBJECT
                elif schema_type_str == "ARRAY":
                    schema_type = types.Type.ARRAY
                elif schema_type_str == "STRING":
                    schema_type = types.Type.STRING
                elif schema_type_str == "INTEGER":
                    schema_type = types.Type.INTEGER
                elif schema_type_str == "NUMBER":
                    schema_type = types.Type.NUMBER
                elif schema_type_str == "BOOLEAN":
                    schema_type = types.Type.BOOLEAN
                else:
                    schema_type = types.Type.STRING

                properties = {}
                if "properties" in schema_dict:
                    for k, v in schema_dict["properties"].items():
                        properties[k] = build_schema(v)

                items = None
                if "items" in schema_dict:
                    items = build_schema(schema_dict["items"])

                return types.Schema(
                    type=schema_type,
                    description=schema_dict.get("description", ""),
                    properties=properties if properties else None,
                    items=items,
                    required=schema_dict.get("required", None),
                    enum=schema_dict.get("enum", None)
                )

            func_decl = types.FunctionDeclaration(
                name=tool.name,
                description=tool.description,
                parameters=build_schema(schema) if schema else None
            )
            declarations.append(func_decl)
            
        return [types.Tool(function_declarations=declarations)]

    def _map_finish_reason(self, reason: types.FinishReason | str | None) -> str | None:
        if reason is None:
            return None
        reason_str = str(reason).upper()
        if reason_str in ("STOP", "FINISH_REASON_STOP"):
            return "end_turn"
        if reason_str in ("MAX_TOKENS", "FINISH_REASON_MAX_TOKENS"):
            return "max_tokens"
        return reason_str.lower()

    def generate(self, input: LLMInput) -> LLMOutput:
        try:
            model_name = ModelResolver.resolve(input.model, provider="gemini")

            tool_result_msgs = [m for m in input.messages if m.role.value == "tool" and m.content]
            if tool_result_msgs:
                try:
                    from llm.dispatcher import Dispatcher
                    from llm.session_recorder import SessionRecorder
                    _post_disp = Dispatcher(recorder=SessionRecorder(session_id=input.session_id or "default"))
                    for _trm in tool_result_msgs:
                        try:
                            _result_payload = json.loads(_trm.content)
                        except Exception:
                            _result_payload = {"result": _trm.content}
                        dispatch_result = _post_disp.dispatch(
                            "PostToolUse",
                            ToolCall(id=_trm.tool_call_id or "", name=_trm.name or "unknown_tool",
                                     arguments={"result": _result_payload, "tool_call_id": _trm.tool_call_id}),
                            session_id=input.session_id,
                        )
                except Exception as _e:
                    logger.warning("PostToolUse dispatch on tool results failed: %s", _e)

            system_instruction = None
            contents = []

            for msg in input.messages:
                role = msg.role.value
                if role == "system":
                    system_instruction = msg.content
                    continue
                
                gemini_role = "user"
                if role == "assistant":
                    gemini_role = "model"
                elif role == "tool":
                    gemini_role = "user"
                
                parts = []
                if role == "tool" and msg.tool_call_id:
                    try:
                        resp_data = json.loads(msg.content)
                    except (json.JSONDecodeError, ValueError):
                        resp_data = {"result": msg.content}
                    parts.append(types.Part.from_function_response(
                        name=msg.name or "unknown_tool",
                        response=resp_data
                    ))
                elif msg.tool_calls:
                    for tc in msg.tool_calls:
                        parts.append(types.Part.from_function_call(
                            name=tc.name,
                            args=tc.arguments
                        ))
                else:
                    parts.append(types.Part.from_text(text=msg.content or ""))
                    
                if parts:
                    contents.append(types.Content(role=gemini_role, parts=parts))

            config_args: dict[str, Any] = {}
            if input.temperature is not None:
                config_args["temperature"] = input.temperature
            if input.max_tokens is not None:
                config_args["max_output_tokens"] = input.max_tokens
            if system_instruction:
                config_args["system_instruction"] = system_instruction
                
            tools_mapped = self._map_tools(input.tools)
            if tools_mapped:
                config_args["tools"] = tools_mapped

            current_model = model_name
            response = None
            last_exception = None
            tried_models: set[str] = set()

            while current_model and current_model not in tried_models:
                tried_models.add(current_model)
                try:
                    response = self.client.models.generate_content(
                        model=current_model,
                        contents=contents,
                        config=types.GenerateContentConfig(**config_args) if config_args else None
                    )
                    model_name = current_model # Update model_name to the one that succeeded
                    break
                except Exception as e:
                    last_exception = e
                    msg = str(e).lower()
                    is_fallback_error = False
                    if isinstance(e, APIError):
                        status = getattr(e, "code", 500)
                        if status in (403, 404, 429):
                            is_fallback_error = True
                    if "403" in msg or "404" in msg or "429" in msg or "quota" in msg or "exhausted" in msg or "not found" in msg or "access" in msg:
                        is_fallback_error = True

                    next_model = self._fallback_chain.get(current_model) or ModelResolver.get_model_info(current_model).get("fallback")
                    if is_fallback_error and next_model and next_model not in tried_models:
                        logger.warning("Gemini model %s unavailable (%s); falling back to %s", current_model, type(e).__name__, next_model)
                        current_model = next_model
                        continue
                    else:
                        raise e
            
            if response is None and last_exception:
                raise last_exception

            extracted_text = ""
            tool_calls = []
            
            if response.candidates and response.candidates[0].content:
                for part in response.candidates[0].content.parts:
                    if part.text:
                        extracted_text += part.text
                    elif part.function_call:
                        args_dict = dict(part.function_call.args) if part.function_call.args else {}
                        tool_calls.append(
                            ToolCall(
                                id=f"call_{part.function_call.name}_{len(tool_calls)}",
                                name=part.function_call.name,
                                arguments=args_dict,
                            )
                        )

            if tool_calls:
                from llm.dispatcher import Dispatcher
                from llm.session_recorder import SessionRecorder

                recorder = SessionRecorder(session_id=input.session_id or "default")
                dispatcher = Dispatcher(recorder=recorder)

                validated_calls = []
                for tc in tool_calls:
                    dispatch_result = dispatcher.dispatch("PreToolUse", tc, session_id=input.session_id)
                    if not dispatch_result.vetoed:
                        validated_calls.append(dispatch_result.tool_call or tc)
                    else:
                        logger.warning(f"ToolCall {tc.name} vetada pelo Dispatcher (PreToolUse).")
                tool_calls = validated_calls

            if not extracted_text and not tool_calls:
                extracted_text = " "

            usage = None
            if response.usage_metadata:
                usage = {
                    "input_tokens": response.usage_metadata.prompt_token_count or 0,
                    "output_tokens": response.usage_metadata.candidates_token_count or 0,
                }

            stop_reason = None
            if response.candidates:
                stop_reason = self._map_finish_reason(response.candidates[0].finish_reason)
                
            if tool_calls and stop_reason != "max_tokens":
                stop_reason = "tool_use"

            return LLMOutput(
                content=extracted_text,
                tool_calls=tool_calls if tool_calls else None,
                model=model_name,
                usage=usage,
                stop_reason=stop_reason,
            )

        except Exception as e:
            msg = str(e).lower()
            if isinstance(e, APIError):
                status = getattr(e, "code", 500)
                if status == 401 or status == 403 or "api key" in msg:
                    raise AuthenticationError(str(e), provider=ProviderType.GEMINI) from e
                if status == 429 or "quota" in msg or "exhausted" in msg:
                    raise RateLimitError(str(e), provider=ProviderType.GEMINI) from e
                if status == 400 and "token" in msg:
                    raise ContextLengthError(str(e), provider=ProviderType.GEMINI) from e
            
            if "401" in msg or "403" in msg or "authentication" in msg:
                raise AuthenticationError(str(e), provider=ProviderType.GEMINI) from e
            if "429" in msg or "rate" in msg or "quota" in msg:
                raise RateLimitError(str(e), provider=ProviderType.GEMINI) from e
            if "context" in msg and "length" in msg:
                raise ContextLengthError(str(e), provider=ProviderType.GEMINI) from e
            if "timeout" in msg:
                 raise LLMError(f"Request timeout: {e}", provider=ProviderType.GEMINI, code="timeout") from e
            
            raise LLMError(f"Unexpected provider error: {e}", provider=ProviderType.GEMINI) from e

    def list_models(self) -> list[ModelInfo]:
        return self._models.copy()

    def validate_config(self) -> bool:
        return bool(self.client.api_key)

    def get_default_model(self) -> str:
        # Honors LLM_MODEL / EGC_MODEL / ECC_MODEL overrides, else the
        # provider default from the registry. No hardcoded model ID here.
        return ModelResolver.resolve(None, provider="gemini")
