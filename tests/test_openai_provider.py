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
