"""Model resolution, capability metadata and dynamic routing layer.

This module decouples the EGC runtime from any single hardcoded model ID.
It supports the full Google / Gemini ecosystem (1.5, 2.0, 2.5 generations,
Vertex AI variants and experimental builds) plus other providers, and is
designed so that future models work without code changes:

* known models live in ``_REGISTRY`` with capability metadata;
* symbolic aliases (including legacy ECC names like ``sonnet`` / ``haiku``)
  map onto real IDs so older agent frontmatter keeps working;
* any string that already looks like a real model ID is passed through;
* unknown IDs still get conservative default metadata instead of crashing.
"""

from __future__ import annotations

import os
from enum import Enum
from typing import Any, Dict, List, Optional

try:  # ModelInfo is dependency-free, but keep the import resilient.
    from llm.core.types import ModelInfo, ProviderType
except Exception:  # pragma: no cover - defensive only
    ModelInfo = None  # type: ignore[assignment]
    ProviderType = None  # type: ignore[assignment]


class ModelCapability(str, Enum):
    REASONING = "reasoning"
    SPEED = "speed"
    MULTIMODAL = "multimodal"
    TOOL_CALLING = "tool_calling"
    LONG_CONTEXT = "long_context"
    LOW_LATENCY = "low_latency"
    COST_EFFICIENT = "cost_efficient"
    CODE = "code"


# Environment variables (canonical first, legacy ECC fallback never removed).
_MODEL_ENV_VARS = ("LLM_MODEL", "EGC_MODEL", "ECC_MODEL")
_EXTRA_MODELS_ENV_VARS = ("EGC_EXTRA_MODELS", "ECC_EXTRA_MODELS")


def _first_env(*names: str) -> Optional[str]:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value.strip()
    return None


class ModelResolver:
    """Centralized model resolution / routing layer for EGC."""

    # OpenRouter model IDs that are reused across the registry, fallback
    # chains and menu_choices() -- centralized here as the single source
    # of truth to avoid typo-prone string duplication.
    _DEEPSEEK_CHAT_V3 = "deepseek/deepseek-chat-v3-0324"
    _QWEN3_32B = "qwen/qwen3-32b"
    _LLAMA4_SCOUT = "meta-llama/llama-4-scout"

    # ------------------------------------------------------------------ #
    # Model registry: real model ID -> capability metadata.
    # ``fallback`` is the next model to try when this one is unavailable
    # (403 / 404 / 429 / quota), forming a degradation chain.
    # ------------------------------------------------------------------ #
    _REGISTRY: Dict[str, Dict[str, Any]] = {
        # --- Gemini 2.5 generation (State of the Art) ---
        "gemini-2.5-pro": {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.CODE,
            ],
            "fallback": "gemini-2.5-flash",
            "context_window": 2000000,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        "gemini-2.5-flash": {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.LOW_LATENCY,
                ModelCapability.COST_EFFICIENT,
            ],
            "fallback": "gemini-2.5-flash-lite",
            "context_window": 1000000,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        "gemini-2.5-flash-lite": {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.LOW_LATENCY,
                ModelCapability.COST_EFFICIENT,
                ModelCapability.TOOL_CALLING,
            ],
            "fallback": "gemini-2.0-flash-lite",
            "context_window": 1000000,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        # --- Gemini 2.0 generation (High Performance) ---
        "gemini-2.0-flash": {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.LOW_LATENCY,
                ModelCapability.COST_EFFICIENT,
            ],
            "fallback": "gemini-2.0-flash-lite",
            "context_window": 1000000,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        "gemini-2.0-flash-lite": {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.LOW_LATENCY,
                ModelCapability.COST_EFFICIENT,
                ModelCapability.TOOL_CALLING,
            ],
            "fallback": "gemini-1.5-flash",
            "context_window": 1000000,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        # --- Gemini 1.5 generation (Legacy Robustness) ---
        "gemini-1.5-pro": {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
            ],
            "fallback": "gemini-2.5-flash",  # Prioritize SOTA flash over legacy flash
            "context_window": 2000000,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        "gemini-1.5-flash": {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LOW_LATENCY,
                ModelCapability.COST_EFFICIENT,
            ],
            "fallback": "gemini-1.5-flash-8b",
            "context_window": 1000000,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        "gemini-1.5-flash-8b": {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.LOW_LATENCY,
                ModelCapability.COST_EFFICIENT,
                ModelCapability.TOOL_CALLING,
            ],
            "fallback": None,
            "context_window": 1000000,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        # --- Other providers (kept minimal; the runtime stays provider-aware) ---
        "claude-opus-4-5": {
            "provider": "claude",
            "capabilities": [ModelCapability.REASONING, ModelCapability.TOOL_CALLING, ModelCapability.CODE],
            "fallback": "claude-sonnet-4-7",
            "context_window": 200000,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        "claude-sonnet-4-7": {
            "provider": "claude",
            "capabilities": [ModelCapability.REASONING, ModelCapability.TOOL_CALLING, ModelCapability.CODE],
            "fallback": "claude-haiku-4-7",
            "context_window": 200000,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        "claude-haiku-4-7": {
            "provider": "claude",
            "capabilities": [ModelCapability.SPEED, ModelCapability.LOW_LATENCY, ModelCapability.TOOL_CALLING],
            "fallback": None,
            "context_window": 200000,
            "max_tokens": 4096,
            "supports_vision": False,
            "supports_tools": True,
        },
        "gpt-4o": {
            "provider": "openai",
            "capabilities": [ModelCapability.REASONING, ModelCapability.MULTIMODAL, ModelCapability.TOOL_CALLING],
            "fallback": "gpt-4o-mini",
            "context_window": 128000,
            "max_tokens": 16384,
            "supports_vision": True,
            "supports_tools": True,
        },
        "gpt-4o-mini": {
            "provider": "openai",
            "capabilities": [ModelCapability.SPEED, ModelCapability.LOW_LATENCY, ModelCapability.COST_EFFICIENT, ModelCapability.TOOL_CALLING],
            "fallback": None,
            "context_window": 128000,
            "max_tokens": 16384,
            "supports_vision": True,
            "supports_tools": True,
        },
        # --- Mistral AI ---
        "mistral-large-latest": {
            "provider": "mistral",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
            ],
            "fallback": None,
            "context_window": 128000,
            "max_tokens": 8192,
            "supports_vision": False,   # Large is text-only; Pixtral is the vision model
            "supports_tools": True,
        },
        # --- Groq ---
        "openai/gpt-oss-120b": {
            "provider": "groq",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.SPEED,
            ],
            "fallback": None,
            "context_window": 131072,
            "max_tokens": 65536,
            "supports_vision": False,
            "supports_tools": True,
        },
        # --- DeepSeek native (api.deepseek.com) ---
        "deepseek-chat": {
            "provider": "deepseek",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
            ],
            "fallback": None,
            "context_window": 64000,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": True,
        },
        "deepseek-reasoner": {
            "provider": "deepseek",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.CODE,
            ],
            "fallback": "deepseek-chat",
            "context_window": 64000,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": False,   # R1 does not support tool calls
        },
        # --- DeepSeek via OpenRouter ---
        "deepseek/deepseek-r1": {
            "provider": "openrouter",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.CODE,
                ModelCapability.TOOL_CALLING,
            ],
            "fallback": _DEEPSEEK_CHAT_V3,
            "context_window": 164000,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": True,
        },
        _DEEPSEEK_CHAT_V3: {
            "provider": "openrouter",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.CODE,
                ModelCapability.COST_EFFICIENT,
            ],
            "fallback": "openai/gpt-4o-mini",
            "context_window": 164000,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": True,
        },
        # --- Qwen via OpenRouter ---
        "qwen/qwen3-235b-a22b": {
            "provider": "openrouter",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.CODE,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
            ],
            "fallback": _QWEN3_32B,
            "context_window": 131072,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": True,
        },
        _QWEN3_32B: {
            "provider": "openrouter",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.CODE,
                ModelCapability.COST_EFFICIENT,
                ModelCapability.TOOL_CALLING,
            ],
            "fallback": "openai/gpt-4o-mini",
            "context_window": 131072,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": True,
        },
        # --- Llama via OpenRouter ---
        "meta-llama/llama-4-maverick": {
            "provider": "openrouter",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
            ],
            "fallback": _LLAMA4_SCOUT,
            "context_window": 1048576,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        _LLAMA4_SCOUT: {
            "provider": "openrouter",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.COST_EFFICIENT,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
            ],
            "fallback": "openai/gpt-4o-mini",
            "context_window": 1048576,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        "meta-llama/llama-3.3-70b-instruct": {
            "provider": "openrouter",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.CODE,
                ModelCapability.COST_EFFICIENT,
                ModelCapability.TOOL_CALLING,
            ],
            "fallback": "openai/gpt-4o-mini",
            "context_window": 131072,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": True,
        },
        "llama3.2": {
            "provider": "ollama",
            "capabilities": [ModelCapability.SPEED, ModelCapability.COST_EFFICIENT],
            "fallback": None,
            "context_window": 128000,
            "max_tokens": 4096,
            "supports_vision": False,
            "supports_tools": False,
        },
        # --- OpenRouter (broker; any vendor/model ID is also accepted directly) ---
        "openrouter/auto": {
            "provider": "openrouter",
            "capabilities": [ModelCapability.REASONING, ModelCapability.MULTIMODAL, ModelCapability.TOOL_CALLING],
            "fallback": "google/gemini-2.5-flash",
            "context_window": 128000,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        "google/gemini-2.5-pro": {
            "provider": "openrouter",
            "capabilities": [ModelCapability.REASONING, ModelCapability.MULTIMODAL, ModelCapability.TOOL_CALLING, ModelCapability.LONG_CONTEXT, ModelCapability.CODE],
            "fallback": "google/gemini-2.5-flash",
            "context_window": 1048576,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        "google/gemini-2.5-flash": {
            "provider": "openrouter",
            "capabilities": [ModelCapability.SPEED, ModelCapability.MULTIMODAL, ModelCapability.TOOL_CALLING, ModelCapability.LOW_LATENCY, ModelCapability.COST_EFFICIENT],
            "fallback": "openai/gpt-4o-mini",
            "context_window": 1048576,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        "anthropic/claude-sonnet-4.5": {
            "provider": "openrouter",
            "capabilities": [ModelCapability.REASONING, ModelCapability.TOOL_CALLING, ModelCapability.CODE],
            "fallback": "openai/gpt-4o",
            "context_window": 200000,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        "openai/gpt-4o": {
            "provider": "openrouter",
            "capabilities": [ModelCapability.REASONING, ModelCapability.MULTIMODAL, ModelCapability.TOOL_CALLING],
            "fallback": "openai/gpt-4o-mini",
            "context_window": 128000,
            "max_tokens": 16384,
            "supports_vision": True,
            "supports_tools": True,
        },
        "openai/gpt-4o-mini": {
            "provider": "openrouter",
            "capabilities": [ModelCapability.SPEED, ModelCapability.LOW_LATENCY, ModelCapability.COST_EFFICIENT, ModelCapability.TOOL_CALLING],
            "fallback": None,
            "context_window": 128000,
            "max_tokens": 16384,
            "supports_vision": True,
            "supports_tools": True,
        },
    }

    # Symbolic aliases -> real model IDs.  Keeps legacy ECC names and the
    # previous EGC symbolic names (pro/flash/flash-legacy/ultra) valid.
    _ALIASES: Dict[str, str] = {
        # Generic capability tiers.
        "reasoning": "gemini-2.5-pro",
        "balanced": "gemini-2.5-flash",
        "fast": "gemini-2.5-flash",
        "low-latency": "gemini-2.5-flash-lite",
        "low_latency": "gemini-2.5-flash-lite",
        "cheap": "gemini-2.5-flash-lite",
        "lite": "gemini-2.5-flash-lite",
        # Previous EGC symbolic names.
        "pro": "gemini-2.5-pro",
        "flash": "gemini-2.5-flash",
        "flash-lite": "gemini-2.5-flash-lite",
        "flash-legacy": "gemini-1.5-flash",
        "ultra": "gemini-2.5-pro",
        # Legacy ECC / Anthropic-style tier names used in older agent frontmatter.
        "opus": "gemini-2.5-pro",
        "sonnet": "gemini-2.5-flash",
        "haiku": "gemini-2.5-flash-lite",
        # Common provider defaults referenced symbolically.
        "default": "gemini-2.5-pro",
        "gemini": "gemini-2.5-pro",
        "claude": "claude-sonnet-4-7",
        "openai": "gpt-4o",
        "ollama": "llama3.2",
        "openrouter": "openrouter/auto",
        "mistral": "mistral-large-latest",
        "groq": "openai/gpt-oss-120b",
    }

    # Per-provider default model ID (single place provider defaults live).
    _PROVIDER_DEFAULTS: Dict[str, str] = {
        "gemini": "gemini-2.5-pro",
        "claude": "claude-sonnet-4-7",
        "openai": "gpt-4o",
        "ollama": "llama3.2",
        "openrouter": "openrouter/auto",
        "mistral": "mistral-large-latest",
        "deepseek": "deepseek-chat",
        "groq": "openai/gpt-oss-120b",
    }

    _DEFAULT_PROVIDER = "gemini"

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #
    @classmethod
    def _looks_like_real_id(cls, value: str) -> bool:
        v = value.lower()
        return (
            "gemini-" in v
            or "gemma" in v
            or "claude-" in v
            or "mistral-" in v
            or v.startswith(("gpt-", "o1", "o3", "o4", "ministral-", "codestral-",
                              "deepseek-"))  # native DeepSeek IDs
            or "/models/" in v          # Vertex AI fully-qualified path
            or ("/" in v and not v.startswith("/"))  # OpenRouter "vendor/model" style
        )

    @classmethod
    def _provider_for(cls, model_id: str) -> str:
        info = cls._REGISTRY.get(model_id)
        if info and info.get("provider"):
            return str(info["provider"])
        v = model_id.lower()
        # OpenRouter brokers everything under "vendor/model" IDs. Note: this is
        # no longer exclusive to OpenRouter — Groq also hosts "vendor/model"
        # IDs (e.g. "openai/gpt-oss-120b", registered above). Any *unregistered*
        # Groq model with a "/" (e.g. a newer "openai/gpt-oss-20b") will still
        # misroute to "openrouter" here; only registered IDs are exempt via the
        # _REGISTRY lookup above.
        if "/" in v and not v.startswith("/") and "/models/" not in v:
            return "openrouter"
        if "claude-" in v:
            return "claude"
        if v.startswith(("gpt-", "o1", "o3", "o4")):
            return "openai"
        if "mistral" in v or v.startswith(("ministral-", "codestral-")):
            return "mistral"
        if "gemini" in v or "gemma" in v:
            return "gemini"
        # Native DeepSeek model IDs: deepseek-chat, deepseek-reasoner, etc.
        # The bare alias token "deepseek" is excluded — it has no "-" suffix
        # and is resolved via _ALIASES before _provider_for is ever called.
        if v.startswith("deepseek-"):
            return "deepseek"
        return cls._DEFAULT_PROVIDER

    # ------------------------------------------------------------------ #
    # Public resolution API
    # ------------------------------------------------------------------ #
    @classmethod
    def resolve(cls, model_hint: Optional[str] = None, provider: Optional[str] = None) -> str:
        """Resolve a model hint / alias to a concrete model ID.

        Priority:
          1. explicit ``model_hint`` (alias lookup, then pass-through if it
             already looks like a real model ID);
          2. environment override (``LLM_MODEL`` / ``EGC_MODEL`` / ``ECC_MODEL``);
          3. per-provider default;
          4. global default model.
        """
        if model_hint:
            hint = model_hint.strip()
            low = hint.lower()
            if low in cls._REGISTRY:
                return low
            if low in cls._ALIASES:
                return cls._ALIASES[low]
            if cls._looks_like_real_id(hint):
                return hint
            # Unknown symbolic hint: fall through to provider default below.

        return cls.default_model(provider)

    @classmethod
    def default_model(cls, provider: Optional[str] = None) -> str:
        prov = (provider or os.environ.get("LLM_PROVIDER") or cls._DEFAULT_PROVIDER).lower()
        env_model = _first_env(*_MODEL_ENV_VARS)
        if env_model:
            resolved = cls._ALIASES.get(env_model.lower(), env_model)
            # Only honor the env override when it actually belongs to the
            # provider being resolved (selector.py writes PROVIDER+MODEL together).
            if cls._provider_for(resolved) == prov:
                return resolved
        return cls._PROVIDER_DEFAULTS.get(prov, cls._PROVIDER_DEFAULTS[cls._DEFAULT_PROVIDER])

    # ------------------------------------------------------------------ #
    # Fallback chains
    # ------------------------------------------------------------------ #
    @classmethod
    def fallback_chain(cls, model_id: str) -> List[str]:
        """Ordered list of fallback model IDs to try after ``model_id`` fails."""
        chain: List[str] = []
        seen = {model_id}
        current = model_id
        while True:
            info = cls._REGISTRY.get(current)
            nxt = info.get("fallback") if info else None
            if not nxt or nxt in seen:
                break
            chain.append(nxt)
            seen.add(nxt)
            current = nxt
        return chain

    @classmethod
    def fallback_map(cls, *extra_models: str) -> Dict[str, str]:
        """Flat ``{model_id: next_fallback_id}`` map for all registry models.

        ``extra_models`` lets callers (e.g. a provider initialised with a
        specific default) make sure their model is represented even if it is
        an unknown / future ID, by seeding it onto the strongest known chain.
        """
        mapping: Dict[str, str] = {}
        for model_id, info in cls._REGISTRY.items():
            nxt = info.get("fallback")
            if nxt and nxt in cls._REGISTRY:
                mapping[model_id] = nxt
        for model_id in extra_models:
            if model_id and model_id not in mapping and model_id not in cls._REGISTRY:
                # Point unknown models at the strongest in-generation fallback.
                seed = "gemini-2.5-flash" if "gemini" in model_id.lower() else None
                if seed and seed in cls._REGISTRY:
                    mapping[model_id] = seed
        return mapping

    @classmethod
    def get_fallback(cls, model_id: str) -> Optional[str]:
        """Backward-compatible single-step fallback lookup."""
        info = cls._REGISTRY.get(model_id)
        if info:
            nxt = info.get("fallback")
            if nxt and nxt in cls._REGISTRY:
                return nxt
        return None

    # ------------------------------------------------------------------ #
    # Metadata
    # ------------------------------------------------------------------ #
    @classmethod
    def get_model_info(cls, model_id: str) -> Dict[str, Any]:
        """Capability metadata for a model ID.

        Unknown / future / Vertex IDs get conservative defaults so callers
        never crash on a model that is not yet in the registry.
        """
        info = cls._REGISTRY.get(model_id)
        if info:
            return dict(info)
        provider = cls._provider_for(model_id)
        return {
            "provider": provider,
            "capabilities": [ModelCapability.TOOL_CALLING],
            "fallback": cls._PROVIDER_DEFAULTS.get(provider) if provider != cls._DEFAULT_PROVIDER else "gemini-2.5-flash",
            "context_window": 32768,
            "max_tokens": 4096,
            "supports_vision": False,
            "supports_tools": True,
            "unknown": True,
        }

    @classmethod
    def capabilities(cls, model_id: str) -> List[ModelCapability]:
        return list(cls.get_model_info(model_id).get("capabilities", []))

    @classmethod
    def supports(cls, model_id: str, capability: ModelCapability) -> bool:
        return capability in cls.capabilities(model_id)

    @classmethod
    def pick_by_capability(
        cls,
        capability: ModelCapability,
        provider: Optional[str] = None,
    ) -> str:
        """Pick the best registry model exposing ``capability`` for a provider."""
        prov = (provider or cls._DEFAULT_PROVIDER).lower()
        for model_id, info in cls._REGISTRY.items():
            if info.get("provider") != prov:
                continue
            if capability in info.get("capabilities", []):
                return model_id
        return cls.default_model(prov)

    # ------------------------------------------------------------------ #
    # Listing
    # ------------------------------------------------------------------ #
    @classmethod
    def list_models(cls, provider: Optional[str] = None) -> List[str]:
        """Real model IDs, optionally filtered by provider, plus env extras."""
        ids = [
            mid
            for mid, info in cls._REGISTRY.items()
            if provider is None or info.get("provider") == provider.lower()
        ]
        extras = _first_env(*_EXTRA_MODELS_ENV_VARS)
        if extras:
            for raw in extras.split(","):
                mid = raw.strip()
                if mid and mid not in ids and (provider is None or cls._provider_for(mid) == provider.lower()):
                    ids.append(mid)
        return ids

    @classmethod
    def list_available_models(cls) -> List[str]:
        """Backward-compatible: symbolic alias names plus tier keywords."""
        names = ["pro", "flash", "flash-lite", "flash-legacy", "ultra"]
        return names + [n for n in cls._ALIASES if n not in names]

    @classmethod
    def model_infos(cls, provider: Optional[str] = None) -> List["ModelInfo"]:
        """``ModelInfo`` objects for use by provider ``list_models()``."""
        if ModelInfo is None or ProviderType is None:  # pragma: no cover
            return []
        out: List[ModelInfo] = []
        for model_id in cls.list_models(provider):
            info = cls.get_model_info(model_id)
            try:
                prov_enum = ProviderType(info.get("provider", cls._DEFAULT_PROVIDER))
            except Exception:
                prov_enum = ProviderType(cls._DEFAULT_PROVIDER)
            out.append(
                ModelInfo(
                    name=model_id,
                    provider=prov_enum,
                    supports_tools=bool(info.get("supports_tools", True)),
                    supports_vision=bool(info.get("supports_vision", False)),
                    max_tokens=info.get("max_tokens"),
                    context_window=info.get("context_window"),
                )
            )
        return out

    @classmethod
    def menu_choices(cls, provider: str) -> List[tuple]:
        """``(model_id, human_label)`` pairs for interactive selectors."""
        labels = {
            "gemini-2.5-pro": "Gemini 2.5 Pro - deepest reasoning, multimodal",
            "gemini-2.5-flash": "Gemini 2.5 Flash - balanced, fast, multimodal",
            "gemini-2.5-flash-lite": "Gemini 2.5 Flash-Lite - lowest latency / cost",
            "gemini-2.0-flash": "Gemini 2.0 Flash - fast, multimodal",
            "gemini-2.0-flash-lite": "Gemini 2.0 Flash-Lite - low cost",
            "gemini-1.5-pro": "Gemini 1.5 Pro - 2M context (legacy capable)",
            "gemini-1.5-flash": "Gemini 1.5 Flash - free-tier friendly",
            "gemini-1.5-flash-8b": "Gemini 1.5 Flash-8B - cheapest legacy",
            "claude-opus-4-5": "Claude Opus 4.5 - most capable",
            "claude-sonnet-4-7": "Claude Sonnet 4.7 - balanced",
            "claude-haiku-4-7": "Claude Haiku 4.7 - fast",
            "gpt-4o": "GPT-4o - most capable",
            "gpt-4o-mini": "GPT-4o-mini - fast & affordable",
            "mistral-large-latest": "Mistral Large - top-tier reasoning and multilingual capabilities",
            "openai/gpt-oss-120b": "GPT-OSS 120B via Groq - fast inference, tool calling",
            "llama3.2": "Llama 3.2 - local general purpose",
            "openrouter/auto": "OpenRouter Auto - broker picks the best model",
            "google/gemini-2.5-pro": "Gemini 2.5 Pro via OpenRouter",
            "google/gemini-2.5-flash": "Gemini 2.5 Flash via OpenRouter",
            "anthropic/claude-sonnet-4.5": "Claude Sonnet 4.5 via OpenRouter",
            "openai/gpt-4o": "GPT-4o via OpenRouter",
            "openai/gpt-4o-mini": "GPT-4o-mini via OpenRouter",
            "deepseek/deepseek-r1": "DeepSeek R1 via OpenRouter - strong reasoning",
            cls._DEEPSEEK_CHAT_V3: "DeepSeek Chat V3 via OpenRouter - cost-efficient",
            "qwen/qwen3-235b-a22b": "Qwen3 235B via OpenRouter - large reasoning model",
            cls._QWEN3_32B: "Qwen3 32B via OpenRouter - balanced & affordable",
            "meta-llama/llama-4-maverick": "Llama 4 Maverick via OpenRouter - multimodal",
            cls._LLAMA4_SCOUT: "Llama 4 Scout via OpenRouter - fast & long context",
            "meta-llama/llama-3.3-70b-instruct": "Llama 3.3 70B via OpenRouter - fast & cheap",
        }
        return [(mid, labels.get(mid, mid)) for mid in cls.list_models(provider)]

    # ------------------------------------------------------------------ #
    # Strategy description (for dashboards / UI metadata)
    # ------------------------------------------------------------------ #
    @classmethod
    def describe_strategy(cls, model_hint: Optional[str] = None, provider: Optional[str] = None) -> Dict[str, str]:
        """Human-readable routing description for UI metadata.

        Returns provider / strategy / preferred-capability instead of a fixed
        model string, so the dashboard never shows ``Model: sonnet`` or
        ``Model: gemini-2.0-flash``` as if it were pinned.
        """
        resolved = cls.resolve(model_hint, provider)
        prov = cls._provider_for(resolved)
        provider_label = {
            "gemini": "Google Gemini",
            "claude": "Anthropic Claude",
            "openai": "OpenAI",
            "mistral": "Mistral AI",
            "ollama": "Ollama (local)",
            "openrouter": "OpenRouter (broker)",
        }.get(prov, prov.title())

        env_model = _first_env(*_MODEL_ENV_VARS)
        env_resolved = cls._ALIASES.get(env_model.lower(), env_model) if env_model else None
        env_pinned = (not model_hint) and env_resolved is not None and cls._provider_for(env_resolved) == prov
        explicit = bool(model_hint) and (
            model_hint.strip().lower() in cls._REGISTRY
            or cls._looks_like_real_id(model_hint.strip())
        )
        if env_pinned:
            strategy = "Pinned via environment"
        elif explicit:
            strategy = "Explicit model (fallback-protected)"
        else:
            strategy = "Dynamic Routing"

        caps = cls.capabilities(resolved)
        if ModelCapability.REASONING in caps:
            preferred = "reasoning"
        elif ModelCapability.LOW_LATENCY in caps or ModelCapability.SPEED in caps:
            preferred = "low-latency"
        elif ModelCapability.CODE in caps:
            preferred = "code"
        else:
            preferred = "general"

        return {
            "provider": provider_label,
            "provider_id": prov,
            "strategy": strategy,
            "preferred_capability": preferred,
            "resolved_model": resolved,
            "fallback_chain": " -> ".join([resolved, *cls.fallback_chain(resolved)]),
        }