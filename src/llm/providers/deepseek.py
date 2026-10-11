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

from llm.core.interface import CLIENT_TIMEOUT, AuthenticationError, LLMProvider
from llm.core.model_resolver import ModelResolver
from llm.core.types import ModelInfo, ProviderType
from llm.providers.openai import OpenAIProvider

DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
_DEFAULT_MODEL = "deepseek-flash"


class DeepSeekProvider(OpenAIProvider):
    provider_type = ProviderType.DEEPSEEK

    def __init__(
        self, api_key: str | None = None, base_url: str | None = None, **kwargs: Any
    ) -> None:
        if OpenAI is None:  # NOSONAR
            raise ImportError("openai package is required to use DeepSeekProvider")
        key = api_key or os.environ.get("DEEPSEEK_API_KEY")
        if not key:
            raise AuthenticationError(
                "No DeepSeek API key provided", provider=ProviderType.DEEPSEEK
            )
        self.client = OpenAI(
            api_key=key,
            base_url=base_url
            or os.environ.get("DEEPSEEK_BASE_URL")
            or DEEPSEEK_BASE_URL,
            timeout=CLIENT_TIMEOUT,
        )
        self._models = ModelResolver.model_infos("deepseek") or [
            ModelInfo(
                name="deepseek-flash",
                provider=ProviderType.DEEPSEEK,
                supports_tools=True,
                supports_vision=False,
                max_tokens=393216,
                context_window=1000000,
            ),
            ModelInfo(
                name="deepseek-v4-pro",
                provider=ProviderType.DEEPSEEK,
                supports_tools=True,
                supports_vision=False,
                max_tokens=393216,
                context_window=1000000,
            ),
        ]

    def generate(self, llm_input: "LLMInput") -> "LLMOutput":  # type: ignore[override]
        from llm.core.types import LLMInput, LLMOutput

        # A retired id (deepseek-chat, deepseek-reasoner, deepseek-v4-flash) is
        # sent as the model the vendor routes it to, so the request names a
        # model the API still lists; the current models take tools and any
        # temperature, so nothing else is normalised.
        model = ModelResolver.resolve(llm_input.model or self.get_default_model(), provider="deepseek")
        if model != llm_input.model:
            llm_input = LLMInput(
                messages=llm_input.messages,
                session_id=llm_input.session_id,
                model=model,
                temperature=llm_input.temperature,
                max_tokens=llm_input.max_tokens,
                tools=llm_input.tools,
                stream=llm_input.stream,
                metadata=llm_input.metadata,
            )
        # The try/except that maps LLMError/NotImplementedError/raw SDK
        # exceptions to this provider lives once, on OpenAIProvider - see
        # OpenAIProvider._wrap_generate_errors for the shared behavior.
        base_generate = super().generate
        return self._wrap_generate_errors(lambda: base_generate(llm_input))

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
