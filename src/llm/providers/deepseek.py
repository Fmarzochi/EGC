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
from llm.core.model_ids import (
    DEEPSEEK_CHAT_RETIRED,
    DEEPSEEK_REASONER_RETIRED,
    DEEPSEEK_V4_FLASH_RETIRED,
    DEEPSEEK_V4_FLASH_VISION_RETIRED,
)
from llm.core.model_resolver import ModelResolver
from llm.core.types import ModelInfo, ProviderType
from llm.providers.openai import OpenAIProvider

DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
_DEFAULT_MODEL = "deepseek-flash"
# The ids the vendor retired (api-docs.deepseek.com/updates, 2026-10-11); only
# these are translated before the request, every other id is sent as given.
_RETIRED_IDS = frozenset({
    DEEPSEEK_CHAT_RETIRED,
    DEEPSEEK_REASONER_RETIRED,
    DEEPSEEK_V4_FLASH_RETIRED,
    DEEPSEEK_V4_FLASH_VISION_RETIRED,
})
# Thinking is a request parameter on the current API (guides/thinking_mode,
# 2026-10-11): it supports tool calls and ignores temperature. A caller asks
# for it with metadata["thinking"] = True; the retired reasoner id, which meant
# "thinking mode of V4 Flash", asks for it too.
_THINKING_METADATA_KEY = "thinking"
_THINKING_EXTRA_BODY = {"thinking": {"type": "enabled"}}


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
        # model the API still lists. Any other id, including one the catalog
        # does not know (a custom base_url deployment), goes out as given; the
        # current models take tools and any temperature, so nothing else is
        # normalised.
        requested = llm_input.model or self.get_default_model()
        model = ModelResolver.resolve(requested, provider="deepseek") if requested in _RETIRED_IDS else requested
        metadata = llm_input.metadata
        if requested == DEEPSEEK_REASONER_RETIRED and not metadata.get(_THINKING_METADATA_KEY):
            metadata = {**metadata, _THINKING_METADATA_KEY: True}
        if model != llm_input.model or metadata is not llm_input.metadata:
            llm_input = LLMInput(
                messages=llm_input.messages,
                session_id=llm_input.session_id,
                model=model,
                temperature=llm_input.temperature,
                max_tokens=llm_input.max_tokens,
                tools=llm_input.tools,
                stream=llm_input.stream,
                metadata=metadata,
            )
        # The try/except that maps LLMError/NotImplementedError/raw SDK
        # exceptions to this provider lives once, on OpenAIProvider - see
        # OpenAIProvider._wrap_generate_errors for the shared behavior.
        base_generate = super().generate
        return self._wrap_generate_errors(lambda: base_generate(llm_input))

    def _extra_request_params(self, llm_input: "LLMInput") -> dict:  # type: ignore[override]
        if llm_input.metadata.get(_THINKING_METADATA_KEY):
            return {"extra_body": dict(_THINKING_EXTRA_BODY)}
        return {}

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
