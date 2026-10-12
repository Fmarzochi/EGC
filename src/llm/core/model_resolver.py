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


# Module-level model ID constants to avoid string duplication (SonarCloud S1192)
GEMINI_25_PRO = "gemini-2.5-pro"
GEMINI_25_FLASH = "gemini-2.5-flash"
GEMINI_25_FLASH_LITE = "gemini-2.5-flash-lite"
GEMINI_20_FLASH_LITE = "gemini-2.0-flash-lite"
GEMINI_15_FLASH = "gemini-1.5-flash"
GEMINI_15_FLASH_8B = "gemini-1.5-flash-8b"
# Gemini API ids checked on 2026-10-11 (ai.google.dev/gemini-api/docs/models and
# docs/deprecations): the 3.x line is current, the 2.5 line is still served to
# accounts that used it, 2.0 and 1.5 are shut down and map to a replacement.
GEMINI_38_FLASH = "gemini-3.8-flash"
GEMINI_36_FLASH = "gemini-3.6-flash"
GEMINI_35_FLASH_LITE = "gemini-3.5-flash-lite"
GEMINI_31_FLASH_LITE = "gemini-3.1-flash-lite"
GEMINI_31_PRO_PREVIEW = "gemini-3.1-pro-preview"
GEMINI_20_FLASH_RETIRED = "gemini-2.0-flash"
GEMINI_15_PRO_RETIRED = "gemini-1.5-pro"
# Claude API ids checked on 2026-10-11 (platform.claude.com, models overview).
CLAUDE_OPUS_55 = "claude-opus-5-5"
CLAUDE_FABLE_51 = "claude-fable-5-1"
CLAUDE_SONNET_55 = "claude-sonnet-5-5"
CLAUDE_HAIKU_55 = "claude-haiku-5-5"
CLAUDE_SONNET_47_RETIRED = "claude-sonnet-4-7"
CLAUDE_HAIKU_47_RETIRED = "claude-haiku-4-7"
# OpenAI ids checked on 2026-10-11 (developers.openai.com/api/docs/models).
GPT6_ASTRA = "gpt-6-astra"
GPT61_SOL = "gpt-6.1-sol"
GPT6_LUNA = "gpt-6-luna"
OPENAI_GPT_4O_MINI = "openai/gpt-4o-mini"
OPENROUTER_AUTO = "openrouter/auto"
OPENAI_GPT_OSS_120B = "openai/gpt-oss-120b"
LLAMA32 = "llama3.2"
# Ollama library ids checked on 2026-10-11 (https://ollama.com/library): the
# bare name is the library default tag; a tagged id such as "qwen3:8b" passes
# through resolve() unchanged.
QWEN3 = "qwen3"
GPT_OSS = "gpt-oss"
LLAMA33 = "llama3.3"
LLAMA31 = "llama3.1"
GEMMA4 = "gemma4"
DEEPSEEK_R1_OLLAMA = "deepseek-r1"
# Groq production ids checked on 2026-10-11 (https://console.groq.com/docs/models).
GROQ_GPT_OSS_20B = "openai/gpt-oss-20b"
GROQ_LLAMA33_70B = "llama-3.3-70b-versatile"
GROQ_LLAMA31_8B = "llama-3.1-8b-instant"
# OpenRouter ids checked on 2026-10-11 (https://openrouter.ai/<vendor>/<model>).
QWEN35_397B = "qwen/qwen3.5-397b-a17b"
QWEN3_235B_RETIRED = "qwen/qwen3-235b-a22b"
ANTHROPIC_CLAUDE_SONNET_55 = "anthropic/claude-sonnet-5.5"
OPENAI_GPT6_ASTRA = "openai/gpt-6-astra"
GOOGLE_GEMINI_38_FLASH = "google/gemini-3.8-flash"
GOOGLE_GEMINI_25_FLASH = "google/gemini-2.5-flash"
OPENAI_GPT_4O = "openai/gpt-4o"
ANTHROPIC_CLAUDE_SONNET_45 = "anthropic/claude-sonnet-4.5"

# Mistral ids checked on 2026-10-11 (docs.mistral.ai: models overview, changelog,
# vibe/code/cli/configuration and studio/conversations/function-calling). The
# "-latest" alias of each line is the id the vendor documents for the API.
MISTRAL_MEDIUM_LATEST = "mistral-medium-latest"
MISTRAL_LARGE_LATEST = "mistral-large-latest"
MISTRAL_LARGE_4 = "mistral-large-4"
MISTRAL_SMALL_LATEST = "mistral-small-latest"
CODESTRAL_LATEST = "codestral-latest"
MINISTRAL_14B_LATEST = "ministral-14b-latest"
MINISTRAL_8B_LATEST = "ministral-8b-latest"
MINISTRAL_3B_LATEST = "ministral-3b-latest"
# Cohere ids checked on 2026-10-11 (docs.cohere.com/docs/models).
COHERE_COMMAND_A_PLUS = "command-a-plus-05-2026"
COHERE_COMMAND_A = "command-a-03-2025"
COHERE_COMMAND_A_REASONING = "command-a-reasoning-08-2025"
COHERE_COMMAND_A_VISION = "command-a-vision-07-2025"
COHERE_COMMAND_A_TRANSLATE = "command-a-translate-08-2025"
COHERE_COMMAND_R_PLUS = "command-r-plus-08-2024"
COHERE_COMMAND_R = "command-r-08-2024"
COHERE_COMMAND_R7B = "command-r7b-12-2024"
# DeepSeek ids checked on 2026-10-11 (api-docs.deepseek.com: quick_start/pricing,
# updates and guides/thinking_mode). Thinking is a request parameter on the
# current API, not a model id.
DEEPSEEK_FLASH = "deepseek-flash"
DEEPSEEK_V4_PRO = "deepseek-v4-pro"
DEEPSEEK_CHAT_RETIRED = "deepseek-chat"
DEEPSEEK_REASONER_RETIRED = "deepseek-reasoner"
DEEPSEEK_V4_FLASH_RETIRED = "deepseek-v4-flash"
DEEPSEEK_V4_FLASH_VISION_RETIRED = "deepseek-v4-flash-vision-exp"


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
    _GPT_4O = "gpt-4o"
    _CLAUDE_SONNET = CLAUDE_SONNET_55
    _OPENROUTER_AUTO = OPENROUTER_AUTO
    _OPENAI_GPT_OSS_120B = OPENAI_GPT_OSS_120B
    _LLAMA32 = LLAMA32
    _QWEN3 = QWEN3
    _GOOGLE_GEMINI_25_FLASH = GOOGLE_GEMINI_25_FLASH
    _CLAUDE_HAIKU = CLAUDE_HAIKU_55
    _GPT_4O_MINI = "gpt-4o-mini"
    _OPENAI_GPT_4O_OR = OPENAI_GPT_4O
    _DEEPSEEK_CHAT_V3 = "deepseek/deepseek-chat-v3-0324"
    _QWEN3_32B = "qwen/qwen3-32b"
    _LLAMA4_SCOUT = "meta-llama/llama-4-scout"

    # ------------------------------------------------------------------ #
    # Model registry: real model ID -> capability metadata.
    # ``fallback`` is the next model to try when this one is unavailable
    # (403 / 404 / 429 / quota), forming a degradation chain.
    # ------------------------------------------------------------------ #
    _REGISTRY: Dict[str, Dict[str, Any]] = {
        # --- Gemini 3.x generation (current line, 2026-10-11) ---
        GEMINI_38_FLASH: {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.CODE,
                ModelCapability.SPEED,
            ],
            "fallback": _GEMINI_36_FLASH,
            "context_window": 1048576,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        GEMINI_31_PRO_PREVIEW: {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.CODE,
            ],
            "fallback": _GEMINI_38_FLASH,
            "context_window": 1048576,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        GEMINI_36_FLASH: {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.COST_EFFICIENT,
            ],
            "fallback": _GEMINI_35_FLASH_LITE,
            "context_window": 1048576,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        GEMINI_35_FLASH_LITE: {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.LOW_LATENCY,
                ModelCapability.COST_EFFICIENT,
                ModelCapability.TOOL_CALLING,
                ModelCapability.MULTIMODAL,
            ],
            "fallback": _GEMINI_31_FLASH_LITE,
            "context_window": 1048576,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        # Shutdown announced for 2027-05-07 (replacement: gemini-3.5-flash-lite).
        GEMINI_31_FLASH_LITE: {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.LOW_LATENCY,
                ModelCapability.COST_EFFICIENT,
                ModelCapability.TOOL_CALLING,
            ],
            "fallback": None,
            "context_window": 1048576,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        # --- Gemini 2.5 generation (still served to accounts that used it; no shutdown date) ---
        GEMINI_25_PRO: {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.CODE,
            ],
            "fallback": _GEMINI_38_FLASH,
            "context_window": 2000000,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        GEMINI_25_FLASH: {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.LOW_LATENCY,
                ModelCapability.COST_EFFICIENT,
            ],
            "fallback": _GEMINI_36_FLASH,
            "context_window": 1000000,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        GEMINI_25_FLASH_LITE: {
            "provider": "gemini",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.LOW_LATENCY,
                ModelCapability.COST_EFFICIENT,
                ModelCapability.TOOL_CALLING,
            ],
            "fallback": _GEMINI_35_FLASH_LITE,
            "context_window": 1000000,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        # Gemini 2.0 and 1.5 are shut down (deprecations page, 2026-10-11): their
        # ids live in _ALIASES as pointers to the replacement the page names.
        # --- Other providers (kept minimal; the runtime stays provider-aware) ---
        # --- Claude (platform.claude.com models overview, 2026-10-11): dateless
        # pinned ids, 1M context and 128K output on the 5.5 generation ---
        CLAUDE_OPUS_55: {
            "provider": "claude",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.MULTIMODAL,
                ModelCapability.LONG_CONTEXT,
            ],
            "fallback": _CLAUDE_SONNET,
            "context_window": 1000000,
            "max_tokens": 128000,
            "supports_vision": True,
            "supports_tools": True,
        },
        CLAUDE_FABLE_51: {
            "provider": "claude",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.MULTIMODAL,
                ModelCapability.LONG_CONTEXT,
            ],
            "fallback": CLAUDE_OPUS_55,
            "context_window": 1000000,
            "max_tokens": 128000,
            "supports_vision": True,
            "supports_tools": True,
        },
        CLAUDE_SONNET_55: {
            "provider": "claude",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.MULTIMODAL,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.SPEED,
            ],
            "fallback": _CLAUDE_HAIKU,
            "context_window": 1000000,
            "max_tokens": 128000,
            "supports_vision": True,
            "supports_tools": True,
        },
        CLAUDE_HAIKU_55: {
            "provider": "claude",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.LOW_LATENCY,
                ModelCapability.COST_EFFICIENT,
                ModelCapability.TOOL_CALLING,
                ModelCapability.MULTIMODAL,
            ],
            "fallback": None,
            "context_window": 1000000,
            "max_tokens": 128000,
            "supports_vision": True,
            "supports_tools": True,
        },
        # Legacy, still available per the overview page.
        "claude-opus-4-5": {
            "provider": "claude",
            "capabilities": [ModelCapability.REASONING, ModelCapability.TOOL_CALLING, ModelCapability.CODE],
            "fallback": _CLAUDE_SONNET,
            "context_window": 200000,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        # --- OpenAI (developers.openai.com models page, 2026-10-11): the GPT-6 line
        # at 1.05M context and 128K output; gpt-4o and gpt-4o-mini still served ---
        GPT6_ASTRA: {
            "provider": "openai",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.CODE,
            ],
            "fallback": GPT61_SOL,
            "context_window": 1050000,
            "max_tokens": 128000,
            "supports_vision": True,
            "supports_tools": True,
        },
        GPT61_SOL: {
            "provider": "openai",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.CODE,
            ],
            "fallback": GPT6_LUNA,
            "context_window": 1050000,
            "max_tokens": 128000,
            "supports_vision": True,
            "supports_tools": True,
        },
        GPT6_LUNA: {
            "provider": "openai",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.COST_EFFICIENT,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
            ],
            "fallback": _GPT_4O,
            "context_window": 1050000,
            "max_tokens": 128000,
            "supports_vision": True,
            "supports_tools": True,
        },
        "gpt-4o": {
            "provider": "openai",
            "capabilities": [ModelCapability.REASONING, ModelCapability.MULTIMODAL, ModelCapability.TOOL_CALLING],
            "fallback": _GPT_4O_MINI,
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
        # --- Mistral AI (docs.mistral.ai, 2026-10-11): the "-latest" aliases the
        # vendor documents; the dated ids they point to are in the PR that added them ---
        MISTRAL_MEDIUM_LATEST: {
            "provider": "mistral",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.MULTIMODAL,
                ModelCapability.LONG_CONTEXT,
            ],
            "fallback": MISTRAL_LARGE_LATEST,
            "context_window": 262144,
            "max_tokens": 32768,
            "supports_vision": True,
            "supports_tools": True,
        },
        MISTRAL_LARGE_LATEST: {
            "provider": "mistral",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.MULTIMODAL,
                ModelCapability.LONG_CONTEXT,
            ],
            "fallback": MISTRAL_SMALL_LATEST,
            "context_window": 262144,
            "max_tokens": 32768,
            "supports_vision": True,
            "supports_tools": True,
        },
        # Public preview since 2026-10-06 (changelog); not a default until it is GA.
        MISTRAL_LARGE_4: {
            "provider": "mistral",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.MULTIMODAL,
                ModelCapability.LONG_CONTEXT,
            ],
            "fallback": MISTRAL_MEDIUM_LATEST,
            "context_window": 1048576,
            "max_tokens": 32768,
            "supports_vision": True,
            "supports_tools": True,
        },
        MISTRAL_SMALL_LATEST: {
            "provider": "mistral",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.MULTIMODAL,
                ModelCapability.SPEED,
                ModelCapability.COST_EFFICIENT,
            ],
            "fallback": MINISTRAL_14B_LATEST,
            "context_window": 262144,
            "max_tokens": 32768,
            "supports_vision": True,
            "supports_tools": True,
        },
        CODESTRAL_LATEST: {
            "provider": "mistral",
            "capabilities": [ModelCapability.CODE, ModelCapability.TOOL_CALLING, ModelCapability.SPEED],
            "fallback": MISTRAL_SMALL_LATEST,
            "context_window": 256000,
            "max_tokens": 4096,
            "supports_vision": False,
            "supports_tools": True,
        },
        MINISTRAL_14B_LATEST: {
            "provider": "mistral",
            "capabilities": [ModelCapability.TOOL_CALLING, ModelCapability.MULTIMODAL, ModelCapability.COST_EFFICIENT],
            "fallback": MINISTRAL_8B_LATEST,
            "context_window": 131072,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        MINISTRAL_8B_LATEST: {
            "provider": "mistral",
            "capabilities": [ModelCapability.TOOL_CALLING, ModelCapability.MULTIMODAL, ModelCapability.SPEED, ModelCapability.COST_EFFICIENT],
            "fallback": MINISTRAL_3B_LATEST,
            "context_window": 131072,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        MINISTRAL_3B_LATEST: {
            "provider": "mistral",
            "capabilities": [ModelCapability.TOOL_CALLING, ModelCapability.MULTIMODAL, ModelCapability.SPEED, ModelCapability.LOW_LATENCY, ModelCapability.COST_EFFICIENT],
            "fallback": None,
            "context_window": 131072,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        # --- Groq (production models, console.groq.com/docs/models, 2026-10-11) ---
        OPENAI_GPT_OSS_120B: {
            "provider": "groq",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.SPEED,
            ],
            "fallback": GROQ_GPT_OSS_20B,
            "context_window": 131072,
            "max_tokens": 65536,
            "supports_vision": False,
            "supports_tools": True,
        },
        GROQ_GPT_OSS_20B: {
            "provider": "groq",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.SPEED,
                ModelCapability.COST_EFFICIENT,
            ],
            "fallback": GROQ_LLAMA33_70B,
            "context_window": 131072,
            "max_tokens": 65536,
            "supports_vision": False,
            "supports_tools": True,
        },
        GROQ_LLAMA33_70B: {
            "provider": "groq",
            "capabilities": [
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.SPEED,
            ],
            "fallback": GROQ_LLAMA31_8B,
            "context_window": 131072,
            "max_tokens": 32768,
            "supports_vision": False,
            "supports_tools": True,
        },
        GROQ_LLAMA31_8B: {
            "provider": "groq",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.LOW_LATENCY,
                ModelCapability.COST_EFFICIENT,
                ModelCapability.TOOL_CALLING,
            ],
            "fallback": None,
            "context_window": 131072,
            "max_tokens": 131072,
            "supports_vision": False,
            "supports_tools": True,
        },
        # --- Cohere (docs.cohere.com/docs/models, 2026-10-11) ---
        COHERE_COMMAND_A_PLUS: {
            "provider": "cohere",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.MULTIMODAL,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.CODE,
            ],
            "fallback": COHERE_COMMAND_A,
            "context_window": 128000,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        COHERE_COMMAND_A: {
            "provider": "cohere",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.CODE,
            ],
            "fallback": COHERE_COMMAND_R_PLUS,
            "context_window": 256000,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": True,
        },
        COHERE_COMMAND_A_REASONING: {
            "provider": "cohere",
            "capabilities": [ModelCapability.REASONING, ModelCapability.TOOL_CALLING, ModelCapability.LONG_CONTEXT],
            "fallback": COHERE_COMMAND_A,
            "context_window": 256000,
            "max_tokens": 32768,
            "supports_vision": False,
            "supports_tools": True,
        },
        COHERE_COMMAND_A_VISION: {
            "provider": "cohere",
            "capabilities": [ModelCapability.MULTIMODAL],
            "fallback": COHERE_COMMAND_A_PLUS,
            "context_window": 128000,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": False,
        },
        COHERE_COMMAND_A_TRANSLATE: {
            "provider": "cohere",
            "capabilities": [ModelCapability.COST_EFFICIENT],
            "fallback": COHERE_COMMAND_A,
            "context_window": 8192,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": False,
        },
        # Previous generation, still served.
        COHERE_COMMAND_R_PLUS: {
            "provider": "cohere",
            "capabilities": [ModelCapability.REASONING, ModelCapability.TOOL_CALLING],
            "fallback": COHERE_COMMAND_R,
            "context_window": 128000,
            "max_tokens": 4096,
            "supports_vision": False,
            "supports_tools": True,
        },
        COHERE_COMMAND_R: {
            "provider": "cohere",
            "capabilities": [ModelCapability.TOOL_CALLING, ModelCapability.SPEED],
            "fallback": COHERE_COMMAND_R7B,
            "context_window": 128000,
            "max_tokens": 4096,
            "supports_vision": False,
            "supports_tools": True,
        },
        COHERE_COMMAND_R7B: {
            "provider": "cohere",
            "capabilities": [ModelCapability.SPEED, ModelCapability.LOW_LATENCY, ModelCapability.COST_EFFICIENT, ModelCapability.TOOL_CALLING],
            "fallback": None,
            "context_window": 128000,
            "max_tokens": 4096,
            "supports_vision": False,
            "supports_tools": True,
        },
        # --- DeepSeek native (api-docs.deepseek.com, 2026-10-11): 1M context and
        # 384K output on both; the retired ids live in _ALIASES ---
        DEEPSEEK_FLASH: {
            "provider": "deepseek",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.SPEED,
                ModelCapability.COST_EFFICIENT,
            ],
            "fallback": None,
            "context_window": 1000000,
            "max_tokens": 393216,
            "supports_vision": False,
            "supports_tools": True,
        },
        DEEPSEEK_V4_PRO: {
            "provider": "deepseek",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.LONG_CONTEXT,
            ],
            "fallback": DEEPSEEK_FLASH,
            "context_window": 1000000,
            "max_tokens": 393216,
            "supports_vision": False,
            "supports_tools": True,
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
            "fallback": _OPENAI_GPT_4O_MINI,
            "context_window": 164000,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": True,
        },
        # --- Qwen via OpenRouter (qwen/qwen3-235b-a22b left the catalog; its
        # id is an alias of this replacement) ---
        QWEN35_397B: {
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
            "fallback": _OPENAI_GPT_4O_MINI,
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
            "fallback": _OPENAI_GPT_4O_MINI,
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
            "fallback": _OPENAI_GPT_4O_MINI,
            "context_window": 131072,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": True,
        },
        # --- Ollama (library ids, ollama.com/library, 2026-10-11) ---
        QWEN3: {
            "provider": "ollama",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.COST_EFFICIENT,
            ],
            "fallback": LLAMA32,
            "context_window": 40960,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": True,
        },
        GPT_OSS: {
            "provider": "ollama",
            "capabilities": [ModelCapability.REASONING, ModelCapability.TOOL_CALLING, ModelCapability.CODE],
            "fallback": QWEN3,
            "context_window": 131072,
            "max_tokens": 65536,
            "supports_vision": False,
            "supports_tools": True,
        },
        LLAMA33: {
            "provider": "ollama",
            "capabilities": [ModelCapability.REASONING, ModelCapability.TOOL_CALLING, ModelCapability.CODE],
            "fallback": QWEN3,
            "context_window": 131072,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": True,
        },
        LLAMA31: {
            "provider": "ollama",
            "capabilities": [ModelCapability.TOOL_CALLING, ModelCapability.CODE],
            "fallback": LLAMA32,
            "context_window": 131072,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": True,
        },
        GEMMA4: {
            "provider": "ollama",
            "capabilities": [ModelCapability.MULTIMODAL, ModelCapability.TOOL_CALLING, ModelCapability.REASONING],
            "fallback": QWEN3,
            "context_window": 131072,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        DEEPSEEK_R1_OLLAMA: {
            "provider": "ollama",
            "capabilities": [ModelCapability.REASONING, ModelCapability.CODE, ModelCapability.TOOL_CALLING],
            "fallback": QWEN3,
            "context_window": 131072,
            "max_tokens": 8192,
            "supports_vision": False,
            "supports_tools": True,
        },
        # Still served by the library (updated two years ago); the default until
        # 2026-10-11, kept so existing configs keep working.
        LLAMA32: {
            "provider": "ollama",
            "capabilities": [ModelCapability.SPEED, ModelCapability.COST_EFFICIENT, ModelCapability.TOOL_CALLING],
            "fallback": None,
            "context_window": 131072,
            "max_tokens": 4096,
            "supports_vision": False,
            "supports_tools": True,
        },
        # --- OpenRouter (broker; any vendor/model ID is also accepted directly) ---
        OPENROUTER_AUTO: {
            "provider": "openrouter",
            "capabilities": [ModelCapability.REASONING, ModelCapability.MULTIMODAL, ModelCapability.TOOL_CALLING],
            "fallback": _GOOGLE_GEMINI_25_FLASH,
            "context_window": 128000,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        ANTHROPIC_CLAUDE_SONNET_55: {
            "provider": "openrouter",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.TOOL_CALLING,
                ModelCapability.CODE,
                ModelCapability.MULTIMODAL,
                ModelCapability.LONG_CONTEXT,
            ],
            "fallback": ANTHROPIC_CLAUDE_SONNET_45,
            "context_window": 1000000,
            "max_tokens": 128000,
            "supports_vision": True,
            "supports_tools": True,
        },
        OPENAI_GPT6_ASTRA: {
            "provider": "openrouter",
            "capabilities": [
                ModelCapability.REASONING,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.CODE,
            ],
            "fallback": OPENAI_GPT_4O,
            "context_window": 1050000,
            "max_tokens": 128000,
            "supports_vision": True,
            "supports_tools": True,
        },
        GOOGLE_GEMINI_38_FLASH: {
            "provider": "openrouter",
            "capabilities": [
                ModelCapability.SPEED,
                ModelCapability.MULTIMODAL,
                ModelCapability.TOOL_CALLING,
                ModelCapability.LONG_CONTEXT,
                ModelCapability.COST_EFFICIENT,
            ],
            "fallback": GOOGLE_GEMINI_25_FLASH,
            "context_window": 1048576,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        "google/gemini-2.5-pro": {
            "provider": "openrouter",
            "capabilities": [ModelCapability.REASONING, ModelCapability.MULTIMODAL, ModelCapability.TOOL_CALLING, ModelCapability.LONG_CONTEXT, ModelCapability.CODE],
            "fallback": _GOOGLE_GEMINI_25_FLASH,
            "context_window": 1048576,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        GOOGLE_GEMINI_25_FLASH: {
            "provider": "openrouter",
            "capabilities": [ModelCapability.SPEED, ModelCapability.MULTIMODAL, ModelCapability.TOOL_CALLING, ModelCapability.LOW_LATENCY, ModelCapability.COST_EFFICIENT],
            "fallback": _OPENAI_GPT_4O_MINI,
            "context_window": 1048576,
            "max_tokens": 65536,
            "supports_vision": True,
            "supports_tools": True,
        },
        ANTHROPIC_CLAUDE_SONNET_45: {
            "provider": "openrouter",
            "capabilities": [ModelCapability.REASONING, ModelCapability.TOOL_CALLING, ModelCapability.CODE],
            "fallback": _OPENAI_GPT_4O_OR,
            "context_window": 200000,
            "max_tokens": 8192,
            "supports_vision": True,
            "supports_tools": True,
        },
        OPENAI_GPT_4O: {
            "provider": "openrouter",
            "capabilities": [ModelCapability.REASONING, ModelCapability.MULTIMODAL, ModelCapability.TOOL_CALLING],
            "fallback": _OPENAI_GPT_4O_MINI,
            "context_window": 128000,
            "max_tokens": 16384,
            "supports_vision": True,
            "supports_tools": True,
        },
        OPENAI_GPT_4O_MINI: {
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