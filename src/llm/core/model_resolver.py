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
from typing import Any, Dict, List, Optional

from llm.core.model_capability import ModelCapability
from llm.core.model_ids import (
    ANTHROPIC_CLAUDE_SONNET_45,
    ANTHROPIC_CLAUDE_SONNET_55,
    CLAUDE_FABLE_51,
    CLAUDE_HAIKU_47_RETIRED,
    CLAUDE_HAIKU_55,
    CLAUDE_OPUS_55,
    CLAUDE_SONNET_47_RETIRED,
    CLAUDE_SONNET_55,
    CODESTRAL_LATEST,
    COHERE_COMMAND_A,
    COHERE_COMMAND_A_PLUS,
    COHERE_COMMAND_A_REASONING,
    COHERE_COMMAND_A_TRANSLATE,
    COHERE_COMMAND_A_VISION,
    COHERE_COMMAND_R,
    COHERE_COMMAND_R7B,
    COHERE_COMMAND_R_PLUS,
    DEEPSEEK_CHAT_RETIRED,
    DEEPSEEK_CHAT_V3,
    DEEPSEEK_FLASH,
    DEEPSEEK_R1_OLLAMA,
    DEEPSEEK_REASONER_RETIRED,
    DEEPSEEK_V4_FLASH_RETIRED,
    DEEPSEEK_V4_FLASH_VISION_RETIRED,
    DEEPSEEK_V4_PRO,
    GEMINI_15_FLASH,
    GEMINI_15_FLASH_8B,
    GEMINI_15_PRO_RETIRED,
    GEMINI_20_FLASH_LITE,
    GEMINI_20_FLASH_RETIRED,
    GEMINI_25_FLASH,
    GEMINI_25_FLASH_LITE,
    GEMINI_25_PRO,
    GEMINI_31_FLASH_LITE,
    GEMINI_31_PRO_PREVIEW,
    GEMINI_35_FLASH_LITE,
    GEMINI_36_FLASH,
    GEMINI_38_FLASH,
    GEMMA4,
    GOOGLE_GEMINI_25_FLASH,
    GOOGLE_GEMINI_38_FLASH,
    GPT61_SOL,
    GPT6_ASTRA,
    GPT6_LUNA,
    GPT_4O,
    GPT_4O_MINI,
    GPT_OSS,
    GROQ_GPT_OSS_20B,
    GROQ_LLAMA31_8B,
    GROQ_LLAMA33_70B,
    LLAMA31,
    LLAMA32,
    LLAMA33,
    LLAMA4_SCOUT,
    MINISTRAL_14B_LATEST,
    MINISTRAL_3B_LATEST,
    MINISTRAL_8B_LATEST,
    MISTRAL_LARGE_4,
    MISTRAL_LARGE_LATEST,
    MISTRAL_MEDIUM_LATEST,
    MISTRAL_SMALL_LATEST,
    OPENAI_GPT6_ASTRA,
    OPENAI_GPT_4O,
    OPENAI_GPT_4O_MINI,
    OPENAI_GPT_OSS_120B,
    OPENROUTER_AUTO,
    QWEN3,
    QWEN35_397B,
    QWEN3_235B_RETIRED,
    QWEN3_32B,
)
from llm.core.model_registry_gemini import GEMINI_MODELS
from llm.core.model_registry_hosted import HOSTED_MODELS
from llm.core.model_registry_open import OPEN_MODELS

try:  # ModelInfo is dependency-free, but keep the import resilient.
    from llm.core.types import ModelInfo, ProviderType
except Exception:  # pragma: no cover - defensive only
    ModelInfo = None  # type: ignore[assignment]
    ProviderType = None  # type: ignore[assignment]

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

    # Model IDs reused across the registry, fallback chains and menu_choices()
    # -- centralized here as the single source of truth to avoid typo-prone
    # string duplication (SonarCloud S1192).
    _GEMINI_25_PRO = GEMINI_25_PRO
    _GEMINI_25_FLASH = GEMINI_25_FLASH
    _GEMINI_25_FLASH_LITE = GEMINI_25_FLASH_LITE
    _GEMINI_20_FLASH_LITE = GEMINI_20_FLASH_LITE
    _GEMINI_15_FLASH = GEMINI_15_FLASH
    _GEMINI_15_FLASH_8B = GEMINI_15_FLASH_8B
    _GEMINI_38_FLASH = GEMINI_38_FLASH
    _GEMINI_36_FLASH = GEMINI_36_FLASH
    _GEMINI_35_FLASH_LITE = GEMINI_35_FLASH_LITE
    _GEMINI_31_FLASH_LITE = GEMINI_31_FLASH_LITE
    _GEMINI_31_PRO_PREVIEW = GEMINI_31_PRO_PREVIEW
    _GPT61_SOL = GPT61_SOL
    _OPENAI_GPT_4O_MINI = OPENAI_GPT_4O_MINI
    _GPT_4O = GPT_4O
    _CLAUDE_SONNET = CLAUDE_SONNET_55
    _OPENROUTER_AUTO = OPENROUTER_AUTO
    _OPENAI_GPT_OSS_120B = OPENAI_GPT_OSS_120B
    _LLAMA32 = LLAMA32
    _QWEN3 = QWEN3
    _GOOGLE_GEMINI_25_FLASH = GOOGLE_GEMINI_25_FLASH
    _CLAUDE_HAIKU = CLAUDE_HAIKU_55
    _GPT_4O_MINI = GPT_4O_MINI
    _OPENAI_GPT_4O_OR = OPENAI_GPT_4O
    _DEEPSEEK_CHAT_V3 = DEEPSEEK_CHAT_V3
    _QWEN3_32B = QWEN3_32B
    _LLAMA4_SCOUT = LLAMA4_SCOUT

    # ------------------------------------------------------------------ #
    # Model registry: real model ID -> capability metadata.
    # ``fallback`` is the next model to try when this one is unavailable
    # (403 / 404 / 429 / quota), forming a degradation chain.
    # ------------------------------------------------------------------ #
    _REGISTRY: Dict[str, Dict[str, Any]] = {**GEMINI_MODELS, **HOSTED_MODELS, **OPEN_MODELS}

    # Symbolic aliases -> real model IDs.  Keeps legacy ECC names and the
    # previous EGC symbolic names (pro/flash/flash-legacy/ultra) valid.
    _ALIASES: Dict[str, str] = {
        # Generic capability tiers.
        # The reasoning tier is the only Pro of the current line, a preview; the
        # generally available default is the 3.8 Flash the models page presents first.
        "reasoning": _GEMINI_31_PRO_PREVIEW,
        "balanced": _GEMINI_38_FLASH,
        "fast": _GEMINI_38_FLASH,
        "low-latency": _GEMINI_35_FLASH_LITE,
        "low_latency": _GEMINI_35_FLASH_LITE,
        "cheap": _GEMINI_35_FLASH_LITE,
        "lite": _GEMINI_35_FLASH_LITE,
        # Previous EGC symbolic names.
        "pro": _GEMINI_31_PRO_PREVIEW,
        "flash": _GEMINI_38_FLASH,
        "flash-lite": _GEMINI_35_FLASH_LITE,
        "flash-legacy": _GEMINI_36_FLASH,
        "ultra": _GEMINI_31_PRO_PREVIEW,
        # Legacy ECC / Anthropic-style tier names used in older agent frontmatter.
        "opus": _GEMINI_31_PRO_PREVIEW,
        "sonnet": _GEMINI_38_FLASH,
        "haiku": _GEMINI_35_FLASH_LITE,
        # Common provider defaults referenced symbolically.
        "default": _GEMINI_38_FLASH,
        "gemini": _GEMINI_38_FLASH,
        "claude": _CLAUDE_SONNET,
        "ollama": _QWEN3,
        "openai": _GPT61_SOL,
        "openrouter": _OPENROUTER_AUTO,
        "mistral": MISTRAL_MEDIUM_LATEST,
        "groq": _OPENAI_GPT_OSS_120B,
        "cohere": COHERE_COMMAND_A_PLUS,
        # Ids the vendors retired, each pointing at the replacement the vendor
        # names, so an old config keeps working (deprecation pages, 2026-10-11).
        "mistral-large-2411": MISTRAL_MEDIUM_LATEST,
        "mistral-medium-2508": MISTRAL_MEDIUM_LATEST,
        "mistral-small-2506": MISTRAL_SMALL_LATEST,
        "command-r-plus": COHERE_COMMAND_R_PLUS,
        "command-r-plus-04-2024": COHERE_COMMAND_R_PLUS,
        "command-r": COHERE_COMMAND_R,
        "command-r-03-2024": COHERE_COMMAND_R,
        "command-light": COHERE_COMMAND_R7B,
        "command": COHERE_COMMAND_R7B,
        DEEPSEEK_CHAT_RETIRED: DEEPSEEK_FLASH,
        DEEPSEEK_REASONER_RETIRED: DEEPSEEK_FLASH,
        DEEPSEEK_V4_FLASH_RETIRED: DEEPSEEK_FLASH,
        DEEPSEEK_V4_FLASH_VISION_RETIRED: DEEPSEEK_FLASH,
        GEMINI_20_FLASH_RETIRED: _GEMINI_36_FLASH,
        _GEMINI_20_FLASH_LITE: _GEMINI_31_FLASH_LITE,
        GEMINI_15_PRO_RETIRED: _GEMINI_38_FLASH,
        _GEMINI_15_FLASH: _GEMINI_36_FLASH,
        _GEMINI_15_FLASH_8B: _GEMINI_35_FLASH_LITE,
        CLAUDE_SONNET_47_RETIRED: CLAUDE_SONNET_55,
        CLAUDE_HAIKU_47_RETIRED: CLAUDE_HAIKU_55,
        QWEN3_235B_RETIRED: QWEN35_397B,
    }

    # Per-provider default model ID (single place provider defaults live).
    _PROVIDER_DEFAULTS: Dict[str, str] = {
        "gemini": _GEMINI_38_FLASH,
        "claude": _CLAUDE_SONNET,
        "ollama": _QWEN3,
        "openai": _GPT61_SOL,
        "openrouter": _OPENROUTER_AUTO,
        "mistral": MISTRAL_MEDIUM_LATEST,
        "deepseek": DEEPSEEK_FLASH,
        "groq": _OPENAI_GPT_OSS_120B,
        "cohere": COHERE_COMMAND_A_PLUS,
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
                              "deepseek-",   # native DeepSeek IDs
                              "command-"))   # native Cohere IDs
            or "/models/" in v          # Vertex AI fully-qualified path
            or ("/" in v and not v.startswith("/"))  # OpenRouter "vendor/model" style
            or (":" in v and "/" not in v and " " not in v)  # Ollama "name:tag" style
        )

    # Providers whose native model IDs also use the "vendor/model" shape,
    # the same shape OpenRouter uses for every model it brokers. An
    # unregistered ID in that shape is ambiguous between them on the string
    # alone.
    _VENDOR_SLASH_PROVIDERS = frozenset({"groq", "openrouter"})

    @classmethod
    def _recognized_provider(cls, model_id: str, expected: Optional[str] = None) -> Optional[str]:
        info = cls._REGISTRY.get(model_id)
        if info and info.get("provider"):
            return str(info["provider"])
        v = model_id.lower()
        # OpenRouter brokers everything under "vendor/model" IDs. Note: this is
        # no longer exclusive to OpenRouter, Groq also hosts "vendor/model"
        # IDs (e.g. "openai/gpt-oss-120b", registered above). An unregistered
        # Groq model with a "/" (e.g. a newer "openai/gpt-oss-20b") is
        # ambiguous from the string alone; trust the caller's own intended
        # provider when it names one of the two that use this shape, instead
        # of always guessing "openrouter".
        if "/" in v and not v.startswith("/") and "/models/" not in v:
            if expected in cls._VENDOR_SLASH_PROVIDERS:
                return expected
            return "openrouter"
        # An Ollama "name:tag" id (qwen3:8b, gpt-oss:120b) is local by shape,
        # judged before the vendor prefixes so gpt-oss:120b does not read as OpenAI.
        if ":" in v and " " not in v:
            return "ollama"
        return cls._native_provider_from_name(v)

    @staticmethod
    def _native_provider_from_name(v: str) -> Optional[str]:
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
        # Native Cohere model IDs: command-a-plus-05-2026, command-r-plus, etc.
        # The bare alias token "cohere" is excluded, no "-" suffix, resolved
        # via _ALIASES before _provider_for is ever called.
        if v.startswith("command-"):
            return "cohere"
        return None

    @classmethod
    def _provider_for(cls, model_id: str, expected: Optional[str] = None) -> str:
        # Nothing recognized the shape (e.g. a native Groq id with no
        # "/", such as "llama-3.3-70b-versatile"). The caller's own expected
        # provider is a stronger signal at this point than the global
        # default, since the id has already been cleared of every other
        # provider's native shape.
        return cls._recognized_provider(model_id, expected) or expected or cls._DEFAULT_PROVIDER

    # ------------------------------------------------------------------ #
    # Public resolution API
    # ------------------------------------------------------------------ #
    @classmethod
    def provider_of(cls, model_id: str) -> Optional[str]:
        """Return the provider that recognizes ``model_id``, or None when none does."""
        return cls._recognized_provider(model_id)

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
            if cls._provider_for(resolved, expected=prov) == prov:
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
                seed = cls._GEMINI_38_FLASH if "gemini" in model_id.lower() else None
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
            "fallback": cls._PROVIDER_DEFAULTS.get(provider) if provider != cls._DEFAULT_PROVIDER else cls._GEMINI_38_FLASH,
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
    def model_infos(
        cls,
        provider: Optional[str] = None,
        tag_as: Optional["ProviderType"] = None,
    ) -> List["ModelInfo"]:
        """``ModelInfo`` objects for use by provider ``list_models()``.

        ``tag_as`` overrides the provider tag on every returned ``ModelInfo``.
        Needed when a provider borrows another provider's registry alias
        (e.g. Vertex AI reusing the "gemini" catalog) instead of registering
        its own rows -- without it, the borrowed rows would carry the
        alias's own provider tag rather than the caller's.
        """
        if ModelInfo is None or ProviderType is None:  # pragma: no cover
            return []
        out: List[ModelInfo] = []
        for model_id in cls.list_models(provider):
            info = cls.get_model_info(model_id)
            if tag_as is not None:
                prov_enum = tag_as
            else:
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
            GEMINI_38_FLASH: "Gemini 3.8 Flash - current default, multimodal, agents",
            GEMINI_31_PRO_PREVIEW: "Gemini 3.1 Pro (preview) - deepest reasoning",
            GEMINI_36_FLASH: "Gemini 3.6 Flash - balanced, fast, multimodal",
            GEMINI_35_FLASH_LITE: "Gemini 3.5 Flash-Lite - lowest latency / cost",
            GEMINI_31_FLASH_LITE: "Gemini 3.1 Flash-Lite - low cost, shuts down 2027-05-07",
            GEMINI_25_PRO: "Gemini 2.5 Pro - previous generation, 2M context",
            GEMINI_25_FLASH: "Gemini 2.5 Flash - previous generation, balanced",
            GEMINI_25_FLASH_LITE: "Gemini 2.5 Flash-Lite - previous generation, low cost",
            CLAUDE_OPUS_55: "Claude Opus 5.5 - most capable",
            CLAUDE_FABLE_51: "Claude Fable 5.1 - frontier tier, 1M context",
            CLAUDE_SONNET_55: "Claude Sonnet 5.5 - balanced default",
            CLAUDE_HAIKU_55: "Claude Haiku 5.5 - fast",
            "claude-opus-4-5": "Claude Opus 4.5 - previous generation",
            GPT6_ASTRA: "GPT-6 Astra - most capable",
            GPT61_SOL: "GPT-6.1 Sol - balanced default",
            GPT6_LUNA: "GPT-6 Luna - fast & affordable",
            "gpt-4o": "GPT-4o - previous generation",
            "gpt-4o-mini": "GPT-4o-mini - previous generation, affordable",
            MISTRAL_MEDIUM_LATEST: "Mistral Medium 3.5 - frontier multimodal, agents and code (default)",
            MISTRAL_LARGE_LATEST: "Mistral Large 3 - open-weight multimodal, 256k context",
            MISTRAL_LARGE_4: "Mistral Large 4 - public preview, 1M context",
            MISTRAL_SMALL_LATEST: "Mistral Small 4 - fast, reasoning and vision in one model",
            CODESTRAL_LATEST: "Codestral - code generation and completion",
            MINISTRAL_14B_LATEST: "Ministral 3 14B - balanced edge model, vision",
            MINISTRAL_8B_LATEST: "Ministral 3 8B - lightweight edge model, vision",
            MINISTRAL_3B_LATEST: "Ministral 3 3B - smallest edge model, vision",
            OPENAI_GPT_OSS_120B: "GPT-OSS 120B via Groq - fast inference, tool calling",
            QWEN3: "Qwen3 - local default, tools and thinking",
            GPT_OSS: "GPT-OSS - local reasoning, 20b default (120b tag available)",
            LLAMA33: "Llama 3.3 70B - local, tools",
            LLAMA31: "Llama 3.1 - local, tools",
            GEMMA4: "Gemma 4 - local, vision and tools",
            DEEPSEEK_R1_OLLAMA: "DeepSeek R1 - local reasoning",
            LLAMA32: "Llama 3.2 - local, the previous default",
            GROQ_GPT_OSS_20B: "GPT-OSS 20B via Groq - fast & affordable",
            GROQ_LLAMA33_70B: "Llama 3.3 70B via Groq - versatile",
            GROQ_LLAMA31_8B: "Llama 3.1 8B via Groq - instant",
            COHERE_COMMAND_A_PLUS: "Command A+ (Cohere) - agentic tool use, vision, multilingual",
            COHERE_COMMAND_A: "Command A (Cohere) - agents and tool use, 256k context",
            COHERE_COMMAND_A_REASONING: "Command A Reasoning (Cohere) - reasoning with tool use",
            COHERE_COMMAND_A_VISION: "Command A Vision (Cohere) - image understanding",
            COHERE_COMMAND_A_TRANSLATE: "Command A Translate (Cohere) - translation",
            COHERE_COMMAND_R_PLUS: "Command R+ 08-2024 (Cohere) - previous generation",
            COHERE_COMMAND_R: "Command R 08-2024 (Cohere) - previous generation, fast",
            COHERE_COMMAND_R7B: "Command R7B (Cohere) - smallest, lowest latency",
            DEEPSEEK_FLASH: "DeepSeek V4.1 Flash - fast, tools, 1M context (default)",
            DEEPSEEK_V4_PRO: "DeepSeek V4 Pro - strongest reasoning, 1M context",
            OPENROUTER_AUTO: "OpenRouter Auto - broker picks the best model",
            "google/gemini-2.5-pro": "Gemini 2.5 Pro via OpenRouter",
            GOOGLE_GEMINI_25_FLASH: "Gemini 2.5 Flash via OpenRouter",
            ANTHROPIC_CLAUDE_SONNET_45: "Claude Sonnet 4.5 via OpenRouter",
            OPENAI_GPT_4O: "GPT-4o via OpenRouter",
            OPENAI_GPT_4O_MINI: "GPT-4o-mini via OpenRouter",
            "deepseek/deepseek-r1": "DeepSeek R1 via OpenRouter - strong reasoning",
            cls._DEEPSEEK_CHAT_V3: "DeepSeek Chat V3 via OpenRouter - cost-efficient",
            QWEN35_397B: "Qwen3.5 397B via OpenRouter - large reasoning model",
            ANTHROPIC_CLAUDE_SONNET_55: "Claude Sonnet 5.5 via OpenRouter",
            OPENAI_GPT6_ASTRA: "GPT-6 Astra via OpenRouter - most capable",
            GOOGLE_GEMINI_38_FLASH: "Gemini 3.8 Flash via OpenRouter",
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
        prov = cls._provider_for(resolved, expected=provider)
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
        env_pinned = (not model_hint) and env_resolved is not None and cls._provider_for(env_resolved, expected=provider) == prov
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