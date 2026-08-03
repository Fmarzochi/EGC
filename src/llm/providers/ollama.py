"""Ollama provider adapter for local models."""

from __future__ import annotations

import os
from typing import Any

from llm.core.interface import (
    AuthenticationError,
    ContextLengthError,
    LLMError,
    LLMProvider,
    RateLimitError,
)
from llm.core.interface import CLIENT_TIMEOUT
from llm.core.redact import redact_secrets
from llm.core.types import (
    LLMInput,
    LLMOutput,
    Message,
    ModelInfo,
    ProviderType,
    ToolCall,
)


def _build_chat_payload(input: LLMInput, model: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": [msg.to_dict() for msg in input.messages],
        "stream": False,
    }
    if input.temperature is not None and abs(input.temperature - 1.0) > 1e-9:
        payload["options"] = {"temperature": input.temperature}
    return payload


def _parse_tool_calls(message: dict[str, Any]) -> list[ToolCall] | None:
    if not message.get("tool_calls"):
        return None
    return [
        ToolCall(
            id=tc.get("id", ""),
            name=tc.get("function", {}).get("name", ""),
            arguments=tc.get("function", {}).get("arguments", {}),
        )
        for tc in message["tool_calls"]
    ]


def _raise_classified_error(exc: Exception) -> None:
    msg = redact_secrets(str(exc))
    if "401" in msg:
        raise AuthenticationError(
            f"Ollama authentication failed: {msg}", provider=ProviderType.OLLAMA
        ) from exc
    if "connection" in msg.lower():
        raise LLMError(
            f"Ollama connection failed: {msg}",
            provider=ProviderType.OLLAMA,
            code="connection_error",
        ) from exc
    if "429" in msg or "rate_limit" in msg.lower():
        raise RateLimitError(msg, provider=ProviderType.OLLAMA) from exc
    if "context" in msg.lower() and "length" in msg.lower():
        raise ContextLengthError(msg, provider=ProviderType.OLLAMA) from exc
    raise


class OllamaProvider(LLMProvider):
    provider_type = ProviderType.OLLAMA

    def __init__(
        self,
        base_url: str | None = None,
        default_model: str | None = None,
    ) -> None:
        self.base_url = base_url or os.environ.get(
            "OLLAMA_BASE_URL", "http://localhost:11434"
        )
        self.default_model = default_model or os.environ.get("OLLAMA_MODEL", "llama3.2")
        self._models = [
            ModelInfo(
                name="llama3.2",
                provider=ProviderType.OLLAMA,
                supports_tools=False,
                supports_vision=False,
                max_tokens=4096,
                context_window=128000,
            ),
            ModelInfo(
                name="mistral",
                provider=ProviderType.OLLAMA,
                supports_tools=False,
                supports_vision=False,
                max_tokens=4096,
                context_window=8192,
            ),
            ModelInfo(
                name="codellama",
                provider=ProviderType.OLLAMA,
                supports_tools=False,
                supports_vision=False,
                max_tokens=4096,
                context_window=16384,
            ),
        ]

    def generate(self, input: LLMInput) -> LLMOutput:
        if input.stream:
            # Streaming is not implemented in this adapter. Fail loudly instead
            # of silently downgrading to a blocking call, which would mislead
            # callers into thinking they are consuming a stream.
            raise NotImplementedError("streaming not supported")
        import urllib.request
        import json

        try:
            url = f"{self.base_url}/api/chat"
            model = input.model or self.default_model
            payload = _build_chat_payload(input, model)

            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                url, data=data, headers={"Content-Type": "application/json"}
            )

            with urllib.request.urlopen(req, timeout=CLIENT_TIMEOUT) as response:
                result = json.loads(response.read().decode("utf-8"))

            message = result.get("message") or {}
            prompt_tokens = result.get("prompt_eval_count", 0)
            completion_tokens = result.get("eval_count", 0)

            return LLMOutput(
                content=message.get("content", ""),
                tool_calls=_parse_tool_calls(message),
                model=model,
                stop_reason=result.get("done_reason"),
                usage={
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": prompt_tokens + completion_tokens,
                },
            )
        except Exception as e:
            _raise_classified_error(e)

    def list_models(self) -> list[ModelInfo]:
        return self._models.copy()

    def validate_config(self) -> bool:
        return bool(self.base_url)

    def get_default_model(self) -> str:
        return self.default_model


__all__ = ["OllamaProvider"]
