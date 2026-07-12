"""Mistral AI provider adapter."""

from __future__ import annotations

import os
from typing import Any

try:
    from openai import OpenAI
except ImportError: 
    OpenAI = None 

from llm.core.interface import AuthenticationError
from llm.core.model_resolver import ModelResolver
from llm.core.types import ModelInfo, ProviderType
from llm.providers.openai import OpenAIProvider

MISTRAL_BASE_URL = "https://api.mistral.ai/v1"


class MistralProvider(OpenAIProvider):
    provider_type = ProviderType.MISTRAL

    def __init__(self, api_key: str | None = None, base_url: str | None = None, **kwargs: Any) -> None:
        if OpenAI is None:
            raise ImportError("openai package is required to use MistralProvider")
            
        key = api_key or os.environ.get("MISTRAL_API_KEY")
        if not key:
            raise AuthenticationError("No Mistral API key provided", provider=ProviderType.MISTRAL)

        self.client = OpenAI(
            api_key=key,
            base_url=base_url or os.environ.get("MISTRAL_BASE_URL") or MISTRAL_BASE_URL,
        )
        
        # Catalogue resolved through the centralized registry fallback pattern
        self._models = ModelResolver.model_infos("mistral") or [
            ModelInfo(
                name="mistral-large-latest",
                provider=ProviderType.MISTRAL,
                supports_tools=True,
                supports_vision=True,
                max_tokens=8192,
                context_window=128000,
            ),
        ]

    def list_models(self) -> list[ModelInfo]:
        return self._models.copy()

    def validate_config(self) -> bool:
        """Validates configuration state. 
        
        Returns True if client initialization has successfully bound an API token.
        """
        api_key = getattr(self.client, "api_key", None)
        return isinstance(api_key, str) and len(api_key.strip()) > 0

    def get_default_model(self) -> str:
        return ModelResolver.resolve(None, provider="mistral")


__all__ = ["MistralProvider", "MISTRAL_BASE_URL"]