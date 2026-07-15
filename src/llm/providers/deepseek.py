"""DeepSeek provider adapter.

DeepSeek exposes an OpenAI-compatible Chat Completions API at
``https://api.deepseek.com/v1``. This adapter reuses the OpenAI transport
logic via :class:`OpenAIProvider` and only changes the base URL, API key
source and default model, so the EGC runtime stays multi-provider without
re-implementing the wire protocol. All model selection still flows through
:class:`ModelResolver`.
"""
from __future__ import annotations

import os
from typing import Any

try:
    from openai import OpenAI
except ImportError:  # pragma: no cover - SDK optional
    OpenAI = None  # type: ignore[assignment]

from llm.core.interface import AuthenticationError, LLMError, LLMProvider
from llm.core.model_resolver import ModelResolver
from llm.core.types import ModelInfo, ProviderType
from llm.providers.openai import OpenAIProvider

DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
_DEFAULT_MODEL = "deepseek-chat"

# deepseek-reasoner (R1) only accepts temperature at or near 1.0.
# Passing any other value causes the API to reject the request.
_REASONER_TEMPERATURE = 1.0


class DeepSeekProvider(OpenAIProvider):
    provider_type = ProviderType.DEEPSEEK

    def __init__(self, api_key: str | None = None, base_url: str | None = None, **kwargs: Any) -> None:
        if OpenAI is None:  # NOSONAR
            raise ImportError("openai package is required to use DeepSeekProvider")
        key = api_key or os.environ.get("DEEPSEEK_API_KEY")
        if not key:
            raise AuthenticationError("No DeepSeek API key provided", provider=ProviderType.DEEPSEEK)
        self.client = OpenAI(
            api_key=key,
            base_url=base_url or os.environ.get("DEEPSEEK_BASE_URL") or DEEPSEEK_BASE_URL,
        )
        self._models = ModelResolver.model_infos("deepseek") or [
            ModelInfo(
                name="deepseek-chat",
                provider=ProviderType.DEEPSEEK,
                supports_tools=True,
                supports_vision=False,
                max_tokens=8192,
                context_window=64000,
            ),
            ModelInfo(
                name="deepseek-reasoner",
                provider=ProviderType.DEEPSEEK,
                supports_tools=False,
                supports_vision=False,
                max_tokens=8192,
                context_window=64000,
            ),
        ]

    def generate(self, llm_input: "LLMInput") -> "LLMOutput":  # type: ignore[override]
        from llm.core.types import LLMInput, LLMOutput
        model = llm_input.model or self.get_default_model()
        if model == "deepseek-reasoner":
            # deepseek-reasoner does not support tool calls or custom
            # temperature values — normalize both to avoid API rejections.
            if llm_input.tools or llm_input.temperature != _REASONER_TEMPERATURE:
                llm_input = LLMInput(
                    messages=llm_input.messages,
                    session_id=llm_input.session_id,
                    model=llm_input.model,
                    temperature=_REASONER_TEMPERATURE,  # fix #1: force to 1.0
                    max_tokens=llm_input.max_tokens,
                    tools=None,
                    stream=llm_input.stream,
                    metadata=llm_input.metadata,
                )
        try:
            return super().generate(llm_input)
        except LLMError as exc:
            # Re-tag in place so telemetry attributes to DEEPSEEK, while
            # preserving the original exception subclass (AuthenticationError,
            # RateLimitError, ContextLengthError, ...) — constructing a new
            # plain LLMError here would discard that subclass information.
            exc.provider = ProviderType.DEEPSEEK
            raise
        except Exception as exc:
            # fix #2: native OpenAI SDK exceptions (RateLimitError,
            # APIConnectionError, AuthenticationError, etc.) propagate here
            # unwrapped when OpenAIProvider.generate() hits the bare `raise`.
            # Wrap them so telemetry always attributes to DEEPSEEK, never OPENAI.
            raise LLMError(
                str(exc),
                provider=ProviderType.DEEPSEEK,
            ) from exc

    def list_models(self) -> list[ModelInfo]:
        return self._models.copy()

    def validate_config(self) -> bool:
        return bool(getattr(self.client, "api_key", None))

    def get_default_model(self) -> str:
        resolved = ModelResolver.resolve(None, provider="deepseek")
        # fix #3: use _provider_for() instead of a fragile string prefix check.
        # Guards against ModelResolver returning a cross-provider default
        # (e.g. gemini-2.5-pro) when no deepseek env override is set.
        if resolved and ModelResolver._provider_for(resolved) == "deepseek":
            return resolved
        return _DEFAULT_MODEL


__all__ = ["DeepSeekProvider", "DEEPSEEK_BASE_URL"]
