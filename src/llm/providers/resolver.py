"""Provider factory and resolver."""

from __future__ import annotations

import os

from llm.core.interface import LLMProvider
from llm.core.types import ProviderType
from llm.providers.claude import ClaudeProvider
from llm.providers.gemini import GeminiProvider
from llm.providers.mistral import MistralProvider 
from llm.providers.ollama import OllamaProvider
from llm.providers.openai import OpenAIProvider
from llm.providers.deepseek import DeepSeekProvider
from llm.providers.groq import GroqProvider
from llm.providers.openrouter import OpenRouterProvider
from llm.providers.vertex_ai import VertexAIProvider

_PROVIDER_MAP: dict[ProviderType, type[LLMProvider]] = {
    ProviderType.CLAUDE: ClaudeProvider,
    ProviderType.OPENAI: OpenAIProvider,
    ProviderType.OLLAMA: OllamaProvider,
    ProviderType.GEMINI: GeminiProvider,
    ProviderType.OPENROUTER: OpenRouterProvider,
    ProviderType.DEEPSEEK: DeepSeekProvider,
    ProviderType.MISTRAL: MistralProvider,
    ProviderType.GROQ: GroqProvider,
    ProviderType.VERTEX_AI: VertexAIProvider,
}


def get_provider(provider_type: ProviderType | str | None = None, **kwargs: str) -> LLMProvider:
    if provider_type is None:
        model_hint = kwargs.get("model")
        if model_hint:
            try:
                from llm.core.model_resolver import ModelResolver

                provider_type = ModelResolver._provider_for(model_hint)
            except Exception:
                provider_type = os.environ.get("LLM_PROVIDER", "gemini").lower()
        else:
            provider_type = os.environ.get("LLM_PROVIDER", "gemini").lower()

    if isinstance(provider_type, str):
        try:
            provider_type = ProviderType(provider_type)
        except ValueError as exc:
            raise ValueError(
                f"Unknown provider type: {provider_type}. "
                f"Valid types: {[p.value for p in ProviderType]}"
            ) from exc

    provider_cls = _PROVIDER_MAP.get(provider_type)
    if provider_cls is None:
        raise ValueError(f"Provider {provider_type} not registered.")

    return provider_cls(**kwargs)


def register_provider(provider_type: ProviderType, provider_cls: type[LLMProvider]) -> None:
    _PROVIDER_MAP[provider_type] = provider_cls