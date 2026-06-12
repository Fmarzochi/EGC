"""OpenAI provider adapter."""

from __future__ import annotations

import json
import os
from typing import Any

try:
    from openai import OpenAI
    _OPENAI_AVAILABLE = True
except ImportError:
    _OPENAI_AVAILABLE = False

from llm.core.interface import (
    AuthenticationError,
    ContextLengthError,
    LLMProvider,
    RateLimitError,
)
from llm.core.types import LLMInput, LLMOutput, Message, ModelInfo, ProviderType, ToolCall
from llm.core.model_resolver import ModelResolver


class OpenAIProvider(LLMProvider):
    provider_type = ProviderType.OPENAI

    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        if not _OPENAI_AVAILABLE:
            raise ImportError(
                "openai package is required to use OpenAIProvider. "
                "Install with: pip install everything-gemini[openai]"
            )
        from openai import OpenAI
        self.client = OpenAI(api_key=api_key or os.environ.get("OPENAI_API_KEY"), base_url=base_url)
        self._models = [
            ModelInfo(
                name="gpt-4o",
                provider=ProviderType.OPENAI,
                supports_tools=True,
                supports_vision=True,
                max_tokens=4096,
                context_window=128000,
            ),
            ModelInfo(
                name="gpt-4o-mini",
                provider=ProviderType.OPENAI,
                supports_tools=True,
                supports_vision=True,
                max_tokens=4096,
                context_window=128000,
            ),
            ModelInfo(
                name="gpt-4-turbo",
                provider=ProviderType.OPENAI,
                supports_tools=True,
                supports_vision=True,
                max_tokens=4096,
                context_window=128000,
            ),
            ModelInfo(
                name="gpt-3.5-turbo",
                provider=ProviderType.OPENAI,
                supports_tools=True,
                supports_vision=False,
                max_tokens=4096,
                context_window=16385,
            ),
        ]

    def generate(self, input: LLMInput) -> LLMOutput:
        try:
            params: dict[str, Any] = {
                "model": input.model or self.get_default_model(),
                "messages": [msg.to_dict() for msg in input.messages],
                "temperature": input.temperature,
            }
            if input.max_tokens:
                params["max_tokens"] = input.max_tokens
            if input.tools:
                params["tools"] = [tool.to_dict() for tool in input.tools]

            response = self.client.chat.completions.create(**params)
            choice = response.choices[0]

            tool_calls = None
            if choice.message.tool_calls:
                tool_calls = [
                    ToolCall(
                        id=tc.id or "",
                        name=tc.function.name,
                        arguments={} if not tc.function.arguments else json.loads(tc.function.arguments),
                    )
                    for tc in choice.message.tool_calls
                ]

            return LLMOutput(
                content=choice.message.content or "",
                tool_calls=tool_calls,
                model=response.model,
                usage={
                    "prompt_tokens": response.usage.prompt_tokens,
                    "completion_tokens": response.usage.completion_tokens,
                    "total_tokens": response.usage.total_tokens,
                },
                stop_reason=choice.finish_reason,
            )
        except Exception as e:
            msg = str(e)
            if "401" in msg or "authentication" in msg.lower():
                raise AuthenticationError(msg, provider=ProviderType.OPENAI) from e
            if "429" in msg or "rate_limit" in msg.lower():
                raise RateLimitError(msg, provider=ProviderType.OPENAI) from e
            if "context" in msg.lower() and "length" in msg.lower():
                raise ContextLengthError(msg, provider=ProviderType.OPENAI) from e
            raise

    def list_models(self) -> list[ModelInfo]:
        return self._models.copy()

    def validate_config(self) -> bool:
        return bool(self.client.api_key)

    def get_default_model(self) -> str:
        # Resolved via the centralized registry (honors LLM_MODEL when it
        # targets the OpenAI provider); no model ID hardcoded here.
        return ModelResolver.resolve(None, provider="openai")
