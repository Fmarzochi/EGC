"""Tests for llm.prompt.builder -- provider-agnostic message assembly.

Part of the src/llm coverage gap flagged by the squad audit (EGC-440). Covers
empty input, prepending the system template, merging with an existing system
message into a single system message, and injecting tool descriptions; and
(#1691) the order of the system parts, the tool parameter listing, keyword
config overrides, and the per-provider builders.
"""
from __future__ import annotations

import pytest

from llm.core.types import Message, Role, ToolDefinition
from llm.prompt.builder import (
    PromptBuilder,
    PromptConfig,
    adapt_messages_for_provider,
    get_provider_builder,
)

_SEARCH_TOOL = ToolDefinition(
    name="search",
    description="find things",
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "what to look for"},
            "limit": {"type": "integer"},
        },
        "required": ["query"],
    },
)


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

    def test_messages_pass_through_when_there_is_nothing_to_add(self):
        messages = [Message(role=Role.USER, content="hi"), Message(role=Role.ASSISTANT, content="hello")]
        assert PromptBuilder().build(messages) == messages

    def test_tools_stay_out_of_the_system_message_when_disabled(self):
        builder = PromptBuilder(PromptConfig(include_tools_in_system=False))
        out = builder.build([Message(role=Role.USER, content="hi")], tools=[_SEARCH_TOOL])
        assert [m.role for m in out] == [Role.USER]

    def test_system_parts_keep_their_order(self):
        builder = PromptBuilder(PromptConfig(system_template="Template."))
        out = builder.build(
            [Message(role=Role.SYSTEM, content="Base."), Message(role=Role.USER, content="hi")],
            tools=[_SEARCH_TOOL],
        )
        system = out[0].content
        assert system.index("Base.") < system.index("Template.") < system.index("## Available Tools")
        assert [m.role for m in out] == [Role.SYSTEM, Role.USER]

    def test_tool_parameters_are_listed_with_type_and_requirement(self):
        out = PromptBuilder().build([Message(role=Role.USER, content="hi")], tools=[_SEARCH_TOOL])
        system = out[0].content
        assert "### search" in system
        assert "  - query: string (required) - what to look for" in system
        assert "  - limit: integer (optional) - " in system

    @pytest.mark.parametrize(
        "parameters",
        [{"type": "string"}, {"type": "object", "properties": {}}],
    )
    def test_parameters_without_properties_are_printed_as_is(self, parameters):
        tool = ToolDefinition(name="raw", description="raw params", parameters=parameters)
        out = PromptBuilder().build([Message(role=Role.USER, content="hi")], tools=[tool])
        assert str(parameters) in out[0].content

    def test_tool_without_parameters_has_no_parameters_section(self):
        tool = ToolDefinition(name="ping", description="no args", parameters={})
        out = PromptBuilder().build([Message(role=Role.USER, content="hi")], tools=[tool])
        assert "### ping\nno args" in out[0].content
        assert "Parameters:" not in out[0].content

    def test_keyword_overrides_build_or_replace_the_config(self):
        assert PromptBuilder(include_tools_in_system=False).config.include_tools_in_system is False
        base = PromptConfig(system_template="Base.", tool_format="text")
        overridden = PromptBuilder(base, system_template="Override.")
        assert overridden.config.system_template == "Override."
        assert overridden.config.tool_format == "text"
        assert base.system_template == "Base."
        assert PromptBuilder(base).config is base


@pytest.mark.unit
class TestProviderBuilders:
    @pytest.mark.parametrize(
        ("provider", "in_system", "tool_format"),
        [
            ("claude", False, "anthropic"),
            ("openai", False, "openai"),
            ("ollama", True, "text"),
            ("gemini", False, "native"),
            ("OLLAMA", True, "text"),
            ("unknown-provider", True, "native"),
        ],
    )
    def test_each_provider_gets_its_template(self, provider, in_system, tool_format):
        config = get_provider_builder(provider).config
        assert config.include_tools_in_system is in_system
        assert config.tool_format == tool_format

    def test_adapt_messages_puts_tools_in_the_system_message_only_for_text_providers(self):
        messages = [Message(role=Role.USER, content="hi")]
        ollama = adapt_messages_for_provider(messages, "ollama", tools=[_SEARCH_TOOL])
        assert ollama[0].role == Role.SYSTEM and "### search" in ollama[0].content
        claude = adapt_messages_for_provider(messages, "claude", tools=[_SEARCH_TOOL])
        assert claude == messages
