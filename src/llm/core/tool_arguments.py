"""Tool-call argument parsing shared by every provider."""

from __future__ import annotations

import json
from typing import Any

from llm.core.interface import ToolArgumentsError
from llm.core.types import ProviderType


def parse_tool_arguments(raw: Any, provider: ProviderType | None = None) -> dict[str, Any]:
    if raw is None or raw == "":
        return {}
    if isinstance(raw, dict):
        return dict(raw)
    if not isinstance(raw, (str, bytes, bytearray)):
        raise ToolArgumentsError(
            f"Tool-call arguments must be a JSON object, got {type(raw).__name__}",
            provider=provider,
        )
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ToolArgumentsError(
            f"Tool-call arguments are not valid JSON ({exc.msg} at position {exc.pos})",
            provider=provider,
        ) from exc
    if not isinstance(value, dict):
        raise ToolArgumentsError(
            f"Tool-call arguments must be a JSON object, got {type(value).__name__}",
            provider=provider,
        )
    return value


__all__ = ["parse_tool_arguments"]
