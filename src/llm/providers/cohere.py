"""Cohere provider adapter.

Cohere's Chat API (v2) is close to, but not exactly, OpenAI-compatible in
wire format: tool definitions use the same JSON-schema shape, but the
response envelope differs (``response.message.content`` is a list of
content blocks, not a plain string; usage lives under
``response.usage.tokens``; finish reasons use Cohere's own vocabulary).
This adapter implements :class:`LLMProvider` directly with Cohere's own
``cohere`` SDK instead of subclassing :class:`OpenAIProvider`.
"""
from __future__ import annotations

import json
import os
from typing import Any

try:
    import cohere
except ImportError:  # pragma: no cover - SDK optional
    cohere = None  # type: ignore[assignment]

from llm.core.interface import AuthenticationError, LLMError, LLMProvider
from llm.core.model_resolver import ModelResolver
from llm.core.types import (
    LLMInput,
    LLMOutput,
    Message,
    ModelInfo,
    ProviderType,
    ToolCall,
    ToolDefinition,
)

COHERE_DEFAULT_MODEL = "command-a-plus-05-2026"


def _map_finish_reason(reason: str | None, has_tool_calls: bool) -> str | None:
    if has_tool_calls:
        return "tool_use"
    if reason is None:
        return None
    reason_str = str(reason).upper()
    if reason_str == "COMPLETE":
        return "end_turn"
    if reason_str == "MAX_TOKENS":
        return "max_tokens"
    return reason_str.lower()


class CohereProvider(LLMProvider):
    provider_type = ProviderType.COHERE

    def __init__(self, api_key: str | None = None, **kwargs: Any) -> None:
        if cohere is None:  # NOSONAR
            raise ImportError("cohere package is required to use CohereProvider")
        key = api_key or os.environ.get("COHERE_API_KEY")
        if not key:
            raise AuthenticationError("No Cohere API key provided", provider=ProviderType.COHERE)
        self._api_key = key
        self.client = cohere.ClientV2(api_key=key)
        self._models = ModelResolver.model_infos("cohere") or [
            ModelInfo(
                name=COHERE_DEFAULT_MODEL,
                provider=ProviderType.COHERE,
                supports_tools=True,
                supports_vision=True,
                max_tokens=65536,
                context_window=128000,
            ),
        ]

    def _map_messages(self, messages: list[Message]) -> list[dict[str, Any]]:
        mapped: list[dict[str, Any]] = []
        for msg in messages:
            role = msg.role.value
            if role == "tool":
                mapped.append({
                    "role": "tool",
                    "tool_call_id": msg.tool_call_id or "",
                    "content": msg.content or "",
                })
                continue
            entry: dict[str, Any] = {"role": role, "content": msg.content or ""}
            if msg.tool_calls:
                entry["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.name, "arguments": _json_dumps(tc.arguments)},
                    }
                    for tc in msg.tool_calls
                ]
            mapped.append(entry)
        return mapped

    def _map_tools(self, tools: list[ToolDefinition] | None) -> list[dict[str, Any]] | None:
        if not tools:
            return None
        return [tool.to_dict() for tool in tools]

    def _parse_tool_calls(self, response) -> list[ToolCall] | None:
        raw = getattr(response.message, "tool_calls", None)
        if not raw:
            return None
        return [
            ToolCall(id=tc.id, name=tc.function.name, arguments=_json_loads(tc.function.arguments))
            for tc in raw
        ]

    def _parse_usage(self, response) -> dict | None:
        meta = getattr(response, "usage", None) or getattr(response, "meta", None)
        tokens = getattr(meta, "tokens", None) if meta else None
        if tokens is None:
            return None
        return {
            "input_tokens": getattr(tokens, "input_tokens", 0) or 0,
            "output_tokens": getattr(tokens, "output_tokens", 0) or 0,
        }

    def _parse_response(self, response, model: str) -> LLMOutput:
        if response.message is None:
            raise LLMError("Cohere returned an empty response", provider=ProviderType.COHERE)
        content_blocks = response.message.content or []
        text = "".join(block.text for block in content_blocks if getattr(block, "text", None))
        tool_calls = self._parse_tool_calls(response)
        return LLMOutput(
            content=text,
            tool_calls=tool_calls,
            model=model,
            usage=self._parse_usage(response),
            stop_reason=_map_finish_reason(response.finish_reason, bool(tool_calls)),
        )

    def generate(self, input: LLMInput) -> LLMOutput:  # type: ignore[override]
        try:
            model = ModelResolver.resolve(input.model, provider="cohere")
            kwargs: dict[str, Any] = {
                "model": model,
                "messages": self._map_messages(input.messages),
            }
            if input.temperature is not None:
                kwargs["temperature"] = input.temperature
            if input.max_tokens is not None:
                kwargs["max_tokens"] = input.max_tokens
            tools_mapped = self._map_tools(input.tools)
            if tools_mapped:
                kwargs["tools"] = tools_mapped
            return self._parse_response(self.client.chat(**kwargs), model)
        except LLMError:
            raise
        except Exception as exc:
            msg = str(exc).lower()
            if "unauthorized" in msg or "api key" in msg or "401" in msg:
                raise AuthenticationError(str(exc), provider=ProviderType.COHERE) from exc
            raise LLMError(str(exc), provider=ProviderType.COHERE) from exc

    def list_models(self) -> list[ModelInfo]:
        return self._models.copy()

    def validate_config(self) -> bool:
        return isinstance(self._api_key, str) and len(self._api_key.strip()) > 0

    def get_default_model(self) -> str:
        resolved = ModelResolver.resolve(None, provider="cohere")
        if resolved and ModelResolver._provider_for(resolved) == "cohere":
            return resolved
        return COHERE_DEFAULT_MODEL


def _json_dumps(value: dict[str, Any]) -> str:
    return json.dumps(value)


def _json_loads(value: str) -> dict[str, Any]:
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return {}


__all__ = ["CohereProvider", "COHERE_DEFAULT_MODEL"]
