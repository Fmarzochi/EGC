"""Mistral AI provider adapter."""

from __future__ import annotations

import os
from typing import Any

try:
    from openai import OpenAI
except ImportError: 
    OpenAI = None 

from llm.core.interface import AuthenticationError, LLMError
from llm.core.model_resolver import ModelResolver
from llm.core.types import ModelInfo, ProviderType
from llm.providers.openai import OpenAIProvider

MISTRAL_BASE_URL = "https://api.mistral.ai/v1"


class MistralProvider(OpenAIProvider):
    provider_type = ProviderType.MISTRAL

    def __init__(self, api_key: str | None = None, base_url: str | None = None, **kwargs: Any) -> None:
        if OpenAI is None:
            raise ImportError("openai package is required to use MistralProvider")
            
        # Unify token capture to a singular value
        resolved_key = api_key or os.environ.get("MISTRAL_API_KEY") or ""
        if not resolved_key.strip():
            raise AuthenticationError("No Mistral API key provided", provider=ProviderType.MISTRAL)

        self.client = OpenAI(
            api_key=resolved_key,
            base_url=base_url or os.environ.get("MISTRAL_BASE_URL") or MISTRAL_BASE_URL,
        )
        
        # Catalogue resolved through the centralized registry fallback pattern
        self._models = ModelResolver.model_infos("mistral") or [
            ModelInfo(
                name="mistral-large-latest",
                provider=ProviderType.MISTRAL,
                supports_tools=True,
                supports_vision=False,   # Large is text-only; Pixtral is the vision model
                max_tokens=8192,
                context_window=128000,
            ),
        ]

    def generate(self, llm_input: "LLMInput") -> "LLMOutput":  # type: ignore[override]
        try:
            return super().generate(llm_input)
        except LLMError as exc:
            # Re-tag LLMErrors so telemetry sees ProviderType.MISTRAL.
            raise LLMError(
                str(exc),
                provider=ProviderType.MISTRAL,
            ) from exc
        except Exception as exc:
            # Native OpenAI SDK exceptions (RateLimitError, APIConnectionError,
            # AuthenticationError, etc.) propagate here unwrapped when
            # OpenAIProvider.generate() hits the bare `raise`. Wrap them so
            # telemetry always attributes to MISTRAL, never OPENAI.
            raise LLMError(
                str(exc),
                provider=ProviderType.MISTRAL,
            ) from exc

    def list_models(self) -> list[ModelInfo]:
        return self._models.copy()

    def validate_config(self) -> bool:
        """Validates configuration state."""
        api_key = getattr(self.client, "api_key", None)
        return isinstance(api_key, str) and len(api_key.strip()) > 0

    def get_default_model(self) -> str:
        return ModelResolver.resolve(None, provider="mistral")


__all__ = ["MistralProvider", "MISTRAL_BASE_URL"]