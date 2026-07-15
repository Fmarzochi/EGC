"""Groq provider adapter.

Groq exposes an OpenAI-compatible Chat Completions API at
``https://api.groq.com/openai/v1``. This adapter reuses the OpenAI transport
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

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
_DEFAULT_MODEL = "openai/gpt-oss-120b"


class GroqProvider(OpenAIProvider):
    provider_type = ProviderType.GROQ

    def __init__(self, api_key: str | None = None, base_url: str | None = None, **kwargs: Any) -> None:
        if OpenAI is None:  # NOSONAR
            raise ImportError("openai package is required to use GroqProvider")
        key = api_key or os.environ.get("GROQ_API_KEY")
        if not key:
            raise AuthenticationError("No Groq API key provided", provider=ProviderType.GROQ)
        self.client = OpenAI(
            api_key=key,
            base_url=base_url or os.environ.get("GROQ_BASE_URL") or GROQ_BASE_URL,
        )
        self._models = ModelResolver.model_infos("groq") or [
            ModelInfo(
                name=_DEFAULT_MODEL,
                provider=ProviderType.GROQ,
                supports_tools=True,
                supports_vision=False,
                max_tokens=65536,
                context_window=131072,
            ),
        ]

    def generate(self, llm_input: "LLMInput") -> "LLMOutput":  # type: ignore[override]
        try:
            return super().generate(llm_input)
        except LLMError as exc:
            # Re-tag LLMErrors so telemetry sees ProviderType.GROQ.
            raise LLMError(
                str(exc),
                provider=ProviderType.GROQ,
            ) from exc
        except Exception as exc:
            # Native OpenAI SDK exceptions (RateLimitError, APIConnectionError,
            # AuthenticationError, etc.) propagate here unwrapped when
            # OpenAIProvider.generate() hits the bare `raise`. Wrap them so
            # telemetry always attributes to GROQ, never OPENAI.
            raise LLMError(
                str(exc),
                provider=ProviderType.GROQ,
            ) from exc

    def list_models(self) -> list[ModelInfo]:
        return self._models.copy()

    def validate_config(self) -> bool:
        api_key = getattr(self.client, "api_key", None)
        return isinstance(api_key, str) and len(api_key.strip()) > 0

    def get_default_model(self) -> str:
        resolved = ModelResolver.resolve(None, provider="groq")
        if resolved and ModelResolver._provider_for(resolved) == "groq":
            return resolved
        return _DEFAULT_MODEL


__all__ = ["GroqProvider", "GROQ_BASE_URL"]
