"""OpenRouter provider adapter.

OpenRouter exposes an OpenAI-compatible Chat Completions API at
``https://openrouter.ai/api/v1`` and brokers access to many vendors
(Anthropic, Google, OpenAI, Meta, Mistral, ...) behind ``vendor/model`` IDs.

This adapter reuses the OpenAI transport logic via :class:`OpenAIProvider`
and only changes the base URL, API key source and default model resolution,
so the EGC runtime stays multi-provider without re-implementing the wire
protocol. All model selection still flows through :class:`ModelResolver`.
"""

from __future__ import annotations

import os
from typing import Any

try:
    from openai import OpenAI
except ImportError:  # pragma: no cover - SDK optional
    OpenAI = None  # type: ignore[assignment]

from llm.core.interface import CLIENT_TIMEOUT, AuthenticationError, LLMProvider
from llm.core.model_resolver import ModelResolver
from llm.core.types import ModelInfo, ProviderType
from llm.providers.openai import OpenAIProvider

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


class OpenRouterProvider(OpenAIProvider):
    provider_type = ProviderType.OPENROUTER

    def __init__(
        self, api_key: str | None = None, base_url: str | None = None, **kwargs: Any
    ) -> None:
        if OpenAI is None:
            raise ImportError("openai package is required to use OpenRouterProvider")
        key = (
            api_key
            or os.environ.get("OPENROUTER_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
        )
        if not key:
            raise AuthenticationError(
                "No OpenRouter API key provided", provider=ProviderType.OPENROUTER
            )

        # OpenRouter recommends (but does not require) attribution headers.
        default_headers = {}
        referer = os.environ.get("OPENROUTER_HTTP_REFERER") or os.environ.get(
            "OPENROUTER_SITE_URL"
        )
        title = os.environ.get("OPENROUTER_X_TITLE") or "EGC"
        if referer:
            default_headers["HTTP-Referer"] = referer
        if title:
            default_headers["X-Title"] = title

        self.client = OpenAI(
            api_key=key,
            base_url=base_url
            or os.environ.get("OPENROUTER_BASE_URL")
            or OPENROUTER_BASE_URL,
            default_headers=default_headers or None,
            timeout=CLIENT_TIMEOUT,
        )
        # Catalogue comes from the centralized registry; OpenRouter also
        # accepts any ``vendor/model`` ID directly (passed through by resolve()).
        self._models = ModelResolver.model_infos("openrouter") or [
            ModelInfo(
                name="openrouter/auto",
                provider=ProviderType.OPENROUTER,
                supports_tools=True,
                supports_vision=True,
                max_tokens=8192,
                context_window=128000,
            ),
        ]

    def list_models(self) -> list[ModelInfo]:
        return self._models.copy()

    def validate_config(self) -> bool:
        return bool(getattr(self.client, "api_key", None))

    def get_default_model(self) -> str:
        # Resolved via the centralized registry (honors LLM_MODEL when it
        # targets the OpenRouter provider); no model ID hardcoded here.
        return ModelResolver.resolve(None, provider="openrouter")


__all__ = ["OpenRouterProvider", "OPENROUTER_BASE_URL"]
