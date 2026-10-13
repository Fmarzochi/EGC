"""Registry entries: Gemini.

Merged into ModelResolver._REGISTRY by llm.core.model_resolver; the order of
the three registry modules is the order of the merged dictionary.
"""

from __future__ import annotations

from typing import Any, Dict

from llm.core.model_capability import ModelCapability
from llm.core.model_ids import (
    GEMINI_25_FLASH,
    GEMINI_25_FLASH_LITE,
    GEMINI_25_PRO,
    GEMINI_31_FLASH_LITE,
    GEMINI_31_PRO_PREVIEW,
    GEMINI_35_FLASH_LITE,
    GEMINI_36_FLASH,
    GEMINI_38_FLASH,
)

GEMINI_MODELS: Dict[str, Dict[str, Any]] = {
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
        "fallback": GEMINI_36_FLASH,
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
        "fallback": GEMINI_38_FLASH,
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
        "fallback": GEMINI_35_FLASH_LITE,
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
        "fallback": GEMINI_31_FLASH_LITE,
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
        "fallback": GEMINI_38_FLASH,
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
        "fallback": GEMINI_36_FLASH,
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
        "fallback": GEMINI_35_FLASH_LITE,
        "context_window": 1000000,
        "max_tokens": 65536,
        "supports_vision": True,
        "supports_tools": True,
    },
    # Gemini 2.0 and 1.5 are shut down (deprecations page, 2026-10-11): their
    # ids live in _ALIASES as pointers to the replacement the page names.
}
