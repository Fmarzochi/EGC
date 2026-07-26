"""Tests for llm.prompt.builder -- provider-agnostic message assembly.

Part of the src/llm coverage gap flagged by the squad audit (EGC-440). Covers
empty input, prepending the system template, merging with an existing system
message into a single system message, and injecting tool descriptions.
"""
from __future__ import annotations

import pytest

from llm.core.types import Message, Role, ToolDefinition
from llm.prompt.builder import PromptBuilder, PromptConfig


@pytest.mark.unit
class TestPromptBuilder:
    def test_empty_messages_return_empty(self):
        assert PromptBuilder().build([]) == []

    def test_system_template_prepended_when_no_system_message(self):
        builder = PromptBuilder(PromptConfig(system_template="You are EGC."))
        out = builder.build([Message(role=Role.USER, content="hi")])
        assert out[0].role == Role.SYSTEM
        assert "You are EGC." in out[0].content
        assert out[-1].content == "hi"

    def test_existing_system_message_is_merged_into_one(self):
        builder = PromptBuilder(PromptConfig(system_template="Extra."))
        out = builder.build([
            Message(role=Role.SYSTEM, content="Base."),
            Message(role=Role.USER, content="hi"),
        ])
        assert out[0].role == Role.SYSTEM
        assert "Base." in out[0].content and "Extra." in out[0].content
        assert sum(1 for m in out if m.role == Role.SYSTEM) == 1

    def test_tool_definitions_injected_into_system(self):
        builder = PromptBuilder(PromptConfig(include_tools_in_system=True))
        tools = [ToolDefinition(name="search", description="find things", parameters={})]
        out = builder.build([Message(role=Role.USER, content="hi")], tools=tools)
        assert out[0].role == Role.SYSTEM
        assert "search" in out[0].content
