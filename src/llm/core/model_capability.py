"""Capability tags a registered model can carry."""

from __future__ import annotations

from enum import Enum


class ModelCapability(str, Enum):
    REASONING = "reasoning"
    SPEED = "speed"
    MULTIMODAL = "multimodal"
    TOOL_CALLING = "tool_calling"
    LONG_CONTEXT = "long_context"
    LOW_LATENCY = "low_latency"
    COST_EFFICIENT = "cost_efficient"
    CODE = "code"
