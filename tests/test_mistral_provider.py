"""Tests for MistralProvider content extraction and model resolution integration."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from llm.core.interface import AuthenticationError, LLMError
from llm.core.model_resolver import ModelResolver, ModelCapability
from llm.core.types import ProviderType
from llm.providers.mistral import MistralProvider


def _simple_input():
    from llm.core.types import LLMInput, Message, Role
    return LLMInput(
        messages=[Message(role=Role.USER, content="hi")],
        model="mistral-large-latest",
    )


def _make_response(choices, stop_reason="stop"):
    response = MagicMock()
    response.choices = choices
    response.model = "mistral-large-latest"
    response.usage.prompt_tokens = 10
    response.usage.completion_tokens = 5
    return response


def _text_choice(text, index=0):
    choice = MagicMock()
    choice.index = index
    choice.message.role = "assistant"
    choice.message.content = text
    choice.message.tool_calls = None
    choice.finish_reason = "stop"
    return choice


def _tool_choice(name="some_tool", tool_id="call_1", arguments=None, index=0):
    choice = MagicMock()
    choice.index = index
    choice.message.role = "assistant"
    choice.message.content = ""
    choice.finish_reason = "tool_calls"
    
    tool_call = MagicMock()
    tool_call.id = tool_id
    tool_call.type = "function"
    
    func_mock = MagicMock()
    func_mock.name = name
    func_mock.arguments = arguments or '{"key": "value"}'
    
    tool_call.function = func_mock
    choice.message.tool_calls = [tool_call]
    return choice


@pytest.fixture
def provider():
    """Build a MistralProvider with a mocked OpenAI client — no real SDK calls."""
    p = MistralProvider.__new__(MistralProvider)
    p.client = MagicMock()
    p.mock_create = MagicMock()
    p.client.chat.completions.create = p.mock_create
    p._models = []
    return p


# --- Content Extraction Tests ---

def test_text_response_returns_content(provider):
    provider.mock_create.return_value = _make_response(
        [_text_choice("hello mistral")]
    )
    result = provider.generate(_simple_input())
    assert result.content == "hello mistral"


def test_tool_use_extracts_calls_properly(provider):
    provider.mock_create.return_value = _make_response(
        [_tool_choice("calculator", "call_99", '{"expr": "2+2"}')],
        stop_reason="tool_calls"
    )
    result = provider.generate(_simple_input())
    assert result.tool_calls is not None
    assert result.tool_calls[0].name == "calculator"
    assert "2+2" in str(result.tool_calls[0].arguments)


def test_empty_choices_raise_llm_error(provider):
    provider.mock_create.return_value = _make_response([])
    with pytest.raises(LLMError) as exc_info:
        provider.generate(_simple_input())
    
    assert exc_info.value.provider == ProviderType.MISTRAL
    assert "empty choices" in str(exc_info.value).lower()


def test_native_sdk_exception_is_retagged_as_mistral(provider):
    """Raw SDK exceptions that bypass OpenAIProvider wrapping must still
    surface as LLMError with provider=MISTRAL, not as bare SDK errors.

    Regression test for audit EGC-128 F3: MistralProvider had no generate()
    override, so OpenAIProvider.generate()'s bare `raise` for unmapped SDK
    exceptions (timeouts, connection errors) propagated as native openai
    exceptions instead of LLMError, with no `.provider` attribute at all.
    """
    provider.mock_create.side_effect = RuntimeError("connection reset")
    with pytest.raises(LLMError) as exc:
        provider.generate(_simple_input())
    assert exc.value.provider == ProviderType.MISTRAL


def test_missing_api_key_raises_authentication_error(monkeypatch):
    """Regression test for audit EGC-128 (medium): Mistral had neither the
    client-side missing-key test nor the real-401 test the other native
    providers from the same batch already had."""
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    with pytest.raises(AuthenticationError) as exc:
        MistralProvider(api_key=None)
    assert exc.value.provider == ProviderType.MISTRAL


def test_unauthorized_exception_raises_authentication_error(provider):
    provider.mock_create.side_effect = RuntimeError("401 unauthorized: invalid api key")
    with pytest.raises(AuthenticationError) as exc:
        provider.generate(_simple_input())
    assert exc.value.provider == ProviderType.MISTRAL


# --- Configuration Tests ---

def test_validate_config_true(provider):
    provider.client.api_key = "valid-key"
    assert provider.validate_config() is True


def test_validate_config_false(provider):
    # Test explicitly against missing, blank or non-string inputs
    provider.client.api_key = None
    assert provider.validate_config() is False

    provider.client.api_key = ""
    assert provider.validate_config() is False

    provider.client.api_key = "   "
    assert provider.validate_config() is False


# --- Core Resolver Capability Verification Tests ---

def test_resolver_mistral_metadata():
    info = ModelResolver.get_model_info("mistral-large-latest")
    assert info["provider"] == "mistral"
    assert info["context_window"] == 128000
    assert info["max_tokens"] == 8192
    assert info["supports_vision"] is False   # Large is text-only; Pixtral is the vision model
    assert info["supports_tools"] is True
    assert ModelCapability.REASONING in info["capabilities"]
    assert ModelCapability.MULTIMODAL not in info["capabilities"]


def test_resolver_mistral_aliases():
    assert ModelResolver.resolve("mistral") == "mistral-large-latest"
    assert ModelResolver.resolve("mistral-large-latest") == "mistral-large-latest"
    assert ModelResolver.default_model(provider="mistral") == "mistral-large-latest"


def test_resolver_menu_and_strategy():
    choices = ModelResolver.menu_choices(provider="mistral")
    assert len(choices) == 1
    assert choices[0][0] == "mistral-large-latest"
    
    desc = ModelResolver.describe_strategy(model_hint="mistral")
    assert desc["provider"] == "Mistral AI"
    assert desc["provider_id"] == "mistral"