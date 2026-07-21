"""Tests for CohereProvider."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from llm.core.interface import CLIENT_TIMEOUT, AuthenticationError, LLMError
from llm.core.types import LLMInput, Message, ProviderType, Role, ToolDefinition
from llm.providers.cohere import COHERE_DEFAULT_MODEL, CohereProvider


def _simple_input() -> LLMInput:
    return LLMInput(
        messages=[Message(role=Role.USER, content="hi")],
        model=COHERE_DEFAULT_MODEL,
    )


def _text_response(text: str = "hello") -> SimpleNamespace:
    block = SimpleNamespace(text=text)
    message = SimpleNamespace(content=[block], tool_calls=None)
    tokens = SimpleNamespace(input_tokens=10, output_tokens=5)
    usage = SimpleNamespace(tokens=tokens)
    return SimpleNamespace(message=message, finish_reason="COMPLETE", usage=usage)


def _tool_call_response(
    name: str = "calculator",
    tool_id: str = "call_1",
    arguments: str = '{"expr": "2+2"}',
) -> SimpleNamespace:
    function = SimpleNamespace(name=name, arguments=arguments)
    tool_call = SimpleNamespace(id=tool_id, type="function", function=function)
    message = SimpleNamespace(content=[], tool_calls=[tool_call])
    tokens = SimpleNamespace(input_tokens=10, output_tokens=5)
    usage = SimpleNamespace(tokens=tokens)
    return SimpleNamespace(message=message, finish_reason=None, usage=usage)


@pytest.fixture
def provider() -> CohereProvider:
    p = CohereProvider.__new__(CohereProvider)
    p.client = MagicMock()
    p._api_key = "test-key"
    p._models = []
    return p


@pytest.mark.unit
def test_provider_type_is_cohere(provider: CohereProvider) -> None:
    assert provider.provider_type == ProviderType.COHERE


@pytest.mark.unit
def test_missing_api_key_raises_authentication_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("COHERE_API_KEY", raising=False)
    with patch("llm.providers.cohere.cohere") as mock_cohere:
        mock_cohere.ClientV2.return_value = MagicMock()
        with pytest.raises(AuthenticationError) as exc:
            CohereProvider(api_key=None)
    assert exc.value.provider == ProviderType.COHERE


@pytest.mark.unit
def test_api_key_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COHERE_API_KEY", "co-test-key")
    with patch("llm.providers.cohere.cohere") as mock_cohere:
        mock_cohere.ClientV2.return_value = MagicMock()
        provider = CohereProvider()
    mock_cohere.ClientV2.assert_called_once_with(
        api_key="co-test-key", timeout=CLIENT_TIMEOUT
    )
    assert provider._api_key == "co-test-key"


@pytest.mark.unit
def test_validate_config_true_when_key_set(provider: CohereProvider) -> None:
    assert provider.validate_config() is True


@pytest.mark.unit
def test_validate_config_false_when_no_key(provider: CohereProvider) -> None:
    provider._api_key = None
    assert provider.validate_config() is False

    provider._api_key = ""
    assert provider.validate_config() is False

    provider._api_key = "   "
    assert provider.validate_config() is False


@pytest.mark.unit
def test_list_models_returns_copy(provider: CohereProvider) -> None:
    provider._models = [MagicMock()]
    result = provider.list_models()
    assert result is not provider._models


@pytest.mark.unit
def test_generate_returns_text_from_content_blocks(provider: CohereProvider) -> None:
    provider.client.chat.return_value = _text_response("hello cohere")
    result = provider.generate(_simple_input())
    assert result.content == "hello cohere"
    assert result.stop_reason == "end_turn"
    assert result.usage == {"input_tokens": 10, "output_tokens": 5}


@pytest.mark.unit
def test_generate_extracts_tool_calls(provider: CohereProvider) -> None:
    provider.client.chat.return_value = _tool_call_response(
        "calculator", "call_99", '{"expr": "2+2"}'
    )
    result = provider.generate(_simple_input())
    assert result.tool_calls is not None
    assert result.tool_calls[0].name == "calculator"
    assert result.tool_calls[0].arguments == {"expr": "2+2"}
    assert result.stop_reason == "tool_use"


@pytest.mark.unit
def test_generate_passes_tools_in_openai_json_schema_shape(
    provider: CohereProvider,
) -> None:
    provider.client.chat.return_value = _text_response("ok")
    tool = ToolDefinition(
        name="search",
        description="search docs",
        parameters={"type": "object", "properties": {}},
    )
    llm_input = LLMInput(messages=[Message(role=Role.USER, content="hi")], tools=[tool])
    provider.generate(llm_input)
    _, kwargs = provider.client.chat.call_args
    assert kwargs["tools"][0]["function"]["name"] == "search"


@pytest.mark.unit
def test_empty_message_raises_llm_error(provider: CohereProvider) -> None:
    response = SimpleNamespace(message=None, finish_reason=None, usage=None)
    provider.client.chat.return_value = response
    with pytest.raises(LLMError) as exc:
        provider.generate(_simple_input())
    assert exc.value.provider == ProviderType.COHERE


@pytest.mark.unit
def test_native_sdk_exception_is_wrapped_as_llm_error(provider: CohereProvider) -> None:
    provider.client.chat.side_effect = RuntimeError("connection reset")
    with pytest.raises(LLMError) as exc:
        provider.generate(_simple_input())
    assert exc.value.provider == ProviderType.COHERE


@pytest.mark.unit
def test_unauthorized_exception_raises_authentication_error(
    provider: CohereProvider,
) -> None:
    provider.client.chat.side_effect = RuntimeError("401 unauthorized: invalid api key")
    with pytest.raises(AuthenticationError) as exc:
        provider.generate(_simple_input())
    assert exc.value.provider == ProviderType.COHERE


@pytest.mark.unit
def test_cohere_in_provider_type_enum() -> None:
    assert ProviderType("cohere") == ProviderType.COHERE


@pytest.mark.unit
def test_get_provider_resolves_cohere(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COHERE_API_KEY", "co-test")
    from llm.providers.resolver import get_provider

    with patch("llm.providers.cohere.cohere") as mock_cohere:
        mock_cohere.ClientV2.return_value = MagicMock()
        p = get_provider("cohere")
    assert isinstance(p, CohereProvider)


@pytest.mark.unit
def test_get_default_model_returns_cohere_model_when_resolver_bleeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COHERE_API_KEY", "co-test")
    with (
        patch("llm.providers.cohere.cohere") as mock_cohere,
        patch(
            "llm.providers.cohere.ModelResolver.resolve", return_value="gemini-2.5-pro"
        ),
    ):
        mock_cohere.ClientV2.return_value = MagicMock()
        p = CohereProvider()
    assert p.get_default_model() == COHERE_DEFAULT_MODEL


@pytest.mark.unit
def test_provider_for_cohere_model_names() -> None:
    from llm.core.model_resolver import ModelResolver

    assert ModelResolver._provider_for("command-a-plus-05-2026") == "cohere"
    assert ModelResolver._provider_for("command-r-plus") == "cohere"
    assert ModelResolver._provider_for("gemini-2.5-pro") != "cohere"


@pytest.mark.unit
def test_model_resolver_default_for_cohere_provider() -> None:
    from llm.core.model_resolver import ModelResolver

    resolved = ModelResolver.resolve(None, provider="cohere")
    assert ModelResolver._provider_for(resolved) == "cohere"
