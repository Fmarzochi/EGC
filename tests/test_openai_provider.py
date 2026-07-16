"""Tests for OpenAIProvider response handling."""

from unittest.mock import MagicMock

import pytest

from llm.core.interface import LLMError
from llm.core.types import LLMInput, Message, ProviderType, Role
from llm.providers.openai import OpenAIProvider


def _simple_input() -> LLMInput:
    return LLMInput(
        messages=[Message(role=Role.USER, content="hi")],
        model="gpt-4o-mini",
    )


@pytest.fixture
def provider() -> OpenAIProvider:
    provider = OpenAIProvider.__new__(OpenAIProvider)
    provider.client = MagicMock()
    provider._models = []
    return provider


@pytest.mark.unit
def test_empty_choices_raise_llm_error(provider: OpenAIProvider) -> None:
    response = MagicMock()
    response.choices = []
    provider.client.chat.completions.create.return_value = response

    with pytest.raises(LLMError) as exc:
        provider.generate(_simple_input())

    assert exc.value.provider == ProviderType.OPENAI
    assert "empty choices" in str(exc.value)


def _make_response(choice, usage=None):
    response = MagicMock()
    response.choices = [choice]
    response.model = "gpt-4o-mini"
    response.usage = usage
    return response


def _text_choice(content):
    choice = MagicMock()
    choice.message.content = content
    choice.message.tool_calls = None
    choice.finish_reason = "stop"
    return choice


@pytest.mark.unit
def test_missing_content_field_defaults_to_empty_string(provider: OpenAIProvider) -> None:
    """Regression test for audit EGC-128 (medium): shallow malformed-response
    coverage — only 'empty choices' was tested before this. A response with
    message.content = None (a real shape: tool-call-only turns, or some
    providers omitting content on certain finish reasons) must not crash."""
    usage = MagicMock(prompt_tokens=1, completion_tokens=2, total_tokens=3)
    provider.client.chat.completions.create.return_value = _make_response(_text_choice(None), usage)

    result = provider.generate(_simple_input())

    assert result.content == ""


@pytest.mark.unit
def test_malformed_tool_call_arguments_json_falls_back_to_empty_dict(provider: OpenAIProvider) -> None:
    choice = MagicMock()
    choice.message.content = ""
    choice.finish_reason = "tool_calls"
    tool_call = MagicMock()
    tool_call.id = "call_1"
    tool_call.function.name = "some_tool"
    tool_call.function.arguments = "{not valid json"
    choice.message.tool_calls = [tool_call]
    usage = MagicMock(prompt_tokens=1, completion_tokens=2, total_tokens=3)
    provider.client.chat.completions.create.return_value = _make_response(choice, usage)

    result = provider.generate(_simple_input())

    assert result.tool_calls[0].arguments == {}


@pytest.mark.unit
def test_missing_usage_degrades_to_zeros_instead_of_crashing(provider: OpenAIProvider) -> None:
    """Regression test for audit EGC-128 (medium): response.usage being None
    (some proxy/gateway responses omit it) used to raise a bare
    AttributeError that bypassed the 401/429/context-length classification
    entirely, surfacing as an unclassified crash instead of a usable
    LLMOutput or a proper LLMError."""
    provider.client.chat.completions.create.return_value = _make_response(_text_choice("hi"), usage=None)

    result = provider.generate(_simple_input())

    assert result.content == "hi"
    assert result.usage == {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
