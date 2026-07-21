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
    CLIENT_TIMEOUT,
    AuthenticationError,
    ContextLengthError,
    LLMProvider,
    RateLimitError,
    ToolExecutionError,
    LLMError,
)
from llm.core.types import (
    LLMInput,
    LLMOutput,
    Message,
    ModelInfo,
    ProviderType,
    ToolCall,
    ToolDefinition,
)
from llm.core.model_resolver import ModelResolver
from llm.core.redact import redact_secrets


class GeminiProvider(LLMProvider):
    provider_type = ProviderType.GEMINI

    def __init__(self, api_key: str | None = None, **kwargs: Any) -> None:
        if genai is None:
            raise ImportError("google-genai package is required to use GeminiProvider")

        key = api_key or os.environ.get("GEMINI_API_KEY")
        if not key:
            raise AuthenticationError(
                "No Gemini API key provided", provider=ProviderType.GEMINI
            )

        self.client = genai.Client(
            api_key=key, http_options={"timeout": int(CLIENT_TIMEOUT * 1000)}
        )

        # Model routing is fully dynamic: defaults, fallbacks and the model
        # catalogue all come from the centralized ModelResolver. No model ID
        # is hardcoded in the provider itself.
        self._default_model = ModelResolver.default_model("gemini")
        self._fallback_chain = ModelResolver.fallback_map(self._default_model)
        self._models = ModelResolver.model_infos("gemini")

    @staticmethod
    def _build_schema(schema_dict: dict[str, Any]) -> "types.Schema":
        _type_map = {
            "OBJECT": types.Type.OBJECT,
            "ARRAY": types.Type.ARRAY,
            "STRING": types.Type.STRING,
            "INTEGER": types.Type.INTEGER,
            "NUMBER": types.Type.NUMBER,
            "BOOLEAN": types.Type.BOOLEAN,
        }
        schema_type = _type_map.get(
            schema_dict.get("type", "STRING").upper(), types.Type.STRING
        )
        properties = {
            k: GeminiProvider._build_schema(v)
            for k, v in schema_dict.get("properties", {}).items()
        }
        items = (
            GeminiProvider._build_schema(schema_dict["items"])
            if "items" in schema_dict
            else None
        )
        return types.Schema(
            type=schema_type,
            description=schema_dict.get("description", ""),
            properties=properties if properties else None,
            items=items,
            required=schema_dict.get("required", None),
            enum=schema_dict.get("enum", None),
        )

    def _map_tools(self, tools: list[ToolDefinition] | None) -> list[types.Tool] | None:
        if not tools:
            return None
        declarations = []
        for tool in tools:
            func_decl = types.FunctionDeclaration(
                name=tool.name,
                description=tool.description,
                parameters=self._build_schema(tool.parameters)
                if tool.parameters
                else None,
            )
            declarations.append(func_decl)
        return [types.Tool(function_declarations=declarations)]

    def _map_finish_reason(
        self, reason: "types.FinishReason | str | None"
    ) -> str | None:
        if reason is None:
            return None
        reason_str = str(reason).upper()
        if reason_str in ("STOP", "FINISH_REASON_STOP"):
            return "end_turn"
        if reason_str in ("MAX_TOKENS", "FINISH_REASON_MAX_TOKENS"):
            return "max_tokens"
        return reason_str.lower()

    def _dispatch_post_tool_results(self, input: LLMInput) -> None:
        tool_result_msgs = [
            m for m in input.messages if m.role.value == "tool" and m.content
        ]
        if not tool_result_msgs:
            return
        try:
            from llm.dispatcher import Dispatcher
            from llm.session_recorder import SessionRecorder

            _post_disp = Dispatcher(
                recorder=SessionRecorder(session_id=input.session_id or "default")
            )
            for _trm in tool_result_msgs:
                try:
                    _result_payload = json.loads(_trm.content)
                except Exception:
                    _result_payload = {"result": _trm.content}
                _post_disp.dispatch(
                    "PostToolUse",
                    ToolCall(
                        id=_trm.tool_call_id or "",
                        name=_trm.name or "unknown_tool",
                        arguments={
                            "result": _result_payload,
                            "tool_call_id": _trm.tool_call_id,
                        },
                    ),
                    session_id=input.session_id,
                )
        except Exception as _e:
            logger.warning("PostToolUse dispatch on tool results failed: %s", _e)

    def _build_message_parts(self, msg) -> list:
        parts = []
        role = msg.role.value
        if role == "tool" and msg.tool_call_id:
            try:
                resp_data = json.loads(msg.content) if msg.content else {}
            except ValueError:
                resp_data = {"result": msg.content or ""}
            parts.append(
                types.Part.from_function_response(
                    name=msg.name or "unknown_tool", response=resp_data
                )
            )
        elif msg.tool_calls:
            for tc in msg.tool_calls:
                parts.append(
                    types.Part.from_function_call(name=tc.name, args=tc.arguments)
                )
        else:
            parts.append(types.Part.from_text(text=msg.content or ""))
        return parts

    def _build_contents(self, messages: list) -> tuple[str | None, list]:
        system_instruction = None
        contents = []
        for msg in messages:
            role = msg.role.value
            if role == "system":
                system_instruction = msg.content
                continue
            gemini_role = "model" if role == "assistant" else "user"
            parts = self._build_message_parts(msg)
            if parts:
                contents.append(types.Content(role=gemini_role, parts=parts))
        return system_instruction, contents

    def _build_config_args(
        self, input: LLMInput, tools_mapped: list | None
    ) -> dict[str, Any]:
        config_args: dict[str, Any] = {}
        if input.temperature is not None:
            config_args["temperature"] = input.temperature
        if input.max_tokens is not None:
            config_args["max_output_tokens"] = input.max_tokens
        if tools_mapped:
            config_args["tools"] = tools_mapped
        return config_args

    def _is_fallback_error(self, e: Exception) -> bool:
        msg = str(e).lower()
        if isinstance(e, APIError):
            status = getattr(e, "code", 500)
            if status in (403, 404, 429):
                return True
        if (
            "403" in msg
            or "404" in msg
            or "429" in msg
            or "quota" in msg
            or "exhausted" in msg
            or "not found" in msg
            or "access" in msg
        ):
            return True
        return False

    def _call_api_with_fallback(
        self,
        model_name: str,
        contents: list,
        config_args: dict,
        system_instruction: str | None,
    ):
        if system_instruction:
            config_args = {**config_args, "system_instruction": system_instruction}
        current_model = model_name
        tried_models: set[str] = set()
        last_exception = None
        response = None

        while current_model and current_model not in tried_models:
            tried_models.add(current_model)
            try:
                response = self.client.models.generate_content(
                    model=current_model,
                    contents=contents,
                    config=types.GenerateContentConfig(**config_args)
                    if config_args
                    else None,
                )
                model_name = current_model
                break
            except Exception as e:
                last_exception = e
                next_model = self._fallback_chain.get(
                    current_model
                ) or ModelResolver.get_model_info(current_model).get("fallback")
                if (
                    self._is_fallback_error(e)
                    and next_model
                    and next_model not in tried_models
                ):
                    logger.warning(
                        "Gemini model %s unavailable (%s); falling back to %s",
                        current_model,
                        type(e).__name__,
                        next_model,
                    )
                    current_model = next_model
                    continue
                raise e

        if response is None and last_exception:
            raise last_exception
        return response, model_name

    def _extract_response_parts(self, response) -> tuple[str, list[ToolCall]]:
        extracted_text = ""
        tool_calls = []
        if response.candidates and response.candidates[0].content:
            for part in response.candidates[0].content.parts:
                if part.text:
                    extracted_text += part.text
                elif part.function_call:
                    args_dict = (
                        dict(part.function_call.args) if part.function_call.args else {}
                    )
                    tool_calls.append(
                        ToolCall(
                            id=f"call_{part.function_call.name}_{len(tool_calls)}",
                            name=part.function_call.name,
                            arguments=args_dict,
                        )
                    )
        return extracted_text, tool_calls

    def _dispatch_pre_tool_calls(
        self, tool_calls: list[ToolCall], input: LLMInput
    ) -> list[ToolCall]:
        from llm.dispatcher import Dispatcher
        from llm.session_recorder import SessionRecorder

        recorder = SessionRecorder(session_id=input.session_id or "default")
        dispatcher = Dispatcher(recorder=recorder)
        validated_calls = []
        for tc in tool_calls:
            dispatch_result = dispatcher.dispatch(
                "PreToolUse", tc, session_id=input.session_id
            )
            if not dispatch_result.vetoed:
                validated_calls.append(dispatch_result.tool_call or tc)
            else:
                logger.warning(
                    f"ToolCall {tc.name} vetada pelo Dispatcher (PreToolUse)."
                )
        return validated_calls

    @staticmethod
    def _check_api_error(e: APIError, msg: str) -> None:
        status = getattr(e, "code", 500)
        if status == 401 or status == 403 or "api key" in msg:
            raise AuthenticationError(
                redact_secrets(str(e)), provider=ProviderType.GEMINI
            ) from e
        if status == 429 or "quota" in msg or "exhausted" in msg:
            raise RateLimitError(
                redact_secrets(str(e)), provider=ProviderType.GEMINI
            ) from e
        if status == 400 and "token" in msg:
            raise ContextLengthError(
                redact_secrets(str(e)), provider=ProviderType.GEMINI
            ) from e

    @staticmethod
    def _map_api_error(e: Exception) -> None:
        msg = str(e).lower()
        if isinstance(e, APIError):
            GeminiProvider._check_api_error(e, msg)
        if "401" in msg or "403" in msg or "authentication" in msg:
            raise AuthenticationError(
                redact_secrets(str(e)), provider=ProviderType.GEMINI
            ) from e
        if "429" in msg or "rate" in msg or "quota" in msg:
            raise RateLimitError(
                redact_secrets(str(e)), provider=ProviderType.GEMINI
            ) from e
        if "context" in msg and "length" in msg:
            raise ContextLengthError(
                redact_secrets(str(e)), provider=ProviderType.GEMINI
            ) from e
        if "timeout" in msg:
            raise LLMError(
                f"Request timeout: {e}", provider=ProviderType.GEMINI, code="timeout"
            ) from e
        raise LLMError(
            f"Unexpected provider error: {e}", provider=ProviderType.GEMINI
        ) from e

    def generate(self, input: LLMInput) -> LLMOutput:
        if input.stream:
            # Streaming is not implemented in this adapter. Fail loudly instead
            # of silently downgrading to a blocking call, which would mislead
            # callers into thinking they are consuming a stream.
            raise NotImplementedError("streaming not supported")
        try:
            model_name = ModelResolver.resolve(input.model, provider="gemini")
            self._dispatch_post_tool_results(input)
            system_instruction, contents = self._build_contents(input.messages)
            tools_mapped = self._map_tools(input.tools)
            config_args = self._build_config_args(input, tools_mapped)
            response, model_name = self._call_api_with_fallback(
                model_name, contents, config_args, system_instruction
            )

            extracted_text, tool_calls = self._extract_response_parts(response)
            if tool_calls:
                tool_calls = self._dispatch_pre_tool_calls(tool_calls, input)
            if not extracted_text and not tool_calls:
                extracted_text = " "

            usage = None
            if response.usage_metadata:
                usage = {
                    "input_tokens": response.usage_metadata.prompt_token_count or 0,
                    "output_tokens": response.usage_metadata.candidates_token_count
                    or 0,
                }

            stop_reason = None
            if response.candidates:
                stop_reason = self._map_finish_reason(
                    response.candidates[0].finish_reason
                )
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
            self._map_api_error(e)

    def list_models(self) -> list[ModelInfo]:
        return self._models.copy()

    def validate_config(self) -> bool:
        return bool(self.client.api_key)

    def get_default_model(self) -> str:
        # Honors LLM_MODEL / EGC_MODEL / ECC_MODEL overrides, else the
        # provider default from the registry. No hardcoded model ID here.
        return ModelResolver.resolve(None, provider="gemini")
