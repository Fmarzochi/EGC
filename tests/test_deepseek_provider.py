"""Tests for DeepSeekProvider."""
from unittest.mock import MagicMock, patch
import pytest
from llm.core.interface import AuthenticationError, LLMError
from llm.core.types import LLMInput, Message, ProviderType, Role
from llm.providers.deepseek import DEEPSEEK_BASE_URL, DeepSeekProvider


def _simple_input() -> LLMInput:
    return LLMInput(
        messages=[Message(role=Role.USER, content="hi")],
        model="deepseek-chat",
    )


@pytest.fixture
def provider() -> DeepSeekProvider:
    p = DeepSeekProvider.__new__(DeepSeekProvider)
    p.client = MagicMock()
    p._models = []
    return p


@pytest.mark.unit
def test_provider_type_is_deepseek(provider: DeepSeekProvider) -> None:
    assert provider.provider_type == ProviderType.DEEPSEEK


@pytest.mark.unit
def test_missing_api_key_raises_authentication_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    with pytest.raises(AuthenticationError) as exc:
        DeepSeekProvider(api_key=None)
    assert exc.value.provider == ProviderType.DEEPSEEK


@pytest.mark.unit
def test_api_key_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test-key")
    with patch("llm.providers.deepseek.OpenAI") as mock_openai:
        mock_openai.return_value = MagicMock()
        provider = DeepSeekProvider()
    mock_openai.assert_called_once()
    _, kwargs = mock_openai.call_args
    assert kwargs["api_key"] == "sk-test-key"
    assert kwargs["base_url"] == DEEPSEEK_BASE_URL


@pytest.mark.unit
def test_custom_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    with patch("llm.providers.deepseek.OpenAI") as mock_openai:
        mock_openai.return_value = MagicMock()
        DeepSeekProvider(base_url="https://custom.deepseek.local/v1")
    _, kwargs = mock_openai.call_args
    assert kwargs["base_url"] == "https://custom.deepseek.local/v1"


@pytest.mark.unit
def test_base_url_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://proxy.internal/v1")
    with patch("llm.providers.deepseek.OpenAI") as mock_openai:
        mock_openai.return_value = MagicMock()
        DeepSeekProvider()
    _, kwargs = mock_openai.call_args
    assert kwargs["base_url"] == "https://proxy.internal/v1"


@pytest.mark.unit
def test_list_models_returns_copy(provider: DeepSeekProvider) -> None:
    provider._models = [MagicMock()]
    result = provider.list_models()
    assert result is not provider._models


@pytest.mark.unit
def test_validate_config_true_when_key_set(provider: DeepSeekProvider) -> None:
    provider.client.api_key = "sk-test"
    assert provider.validate_config() is True


@pytest.mark.unit
def test_validate_config_false_when_no_key(provider: DeepSeekProvider) -> None:
    provider.client.api_key = None
    assert provider.validate_config() is False


@pytest.mark.unit
def test_default_models_include_deepseek_chat(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    with patch("llm.providers.deepseek.OpenAI") as mock_openai, \
         patch("llm.providers.deepseek.ModelResolver.model_infos", return_value=None):
        mock_openai.return_value = MagicMock()
        p = DeepSeekProvider()
    names = [m.name for m in p._models]
    assert "deepseek-chat" in names
    assert "deepseek-reasoner" in names


@pytest.mark.unit
def test_empty_choices_raises_llm_error(provider: DeepSeekProvider) -> None:
    response = MagicMock()
    response.choices = []
    provider.client.chat.completions.create.return_value = response
    with pytest.raises(LLMError) as exc:
        provider.generate(_simple_input())
    assert exc.value.provider == ProviderType.DEEPSEEK


@pytest.mark.unit
def test_deepseek_in_provider_type_enum() -> None:
    assert ProviderType("deepseek") == ProviderType.DEEPSEEK


@pytest.mark.unit
def test_get_provider_resolves_deepseek(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    from llm.providers.resolver import get_provider
    with patch("llm.providers.deepseek.OpenAI") as mock_openai:
        mock_openai.return_value = MagicMock()
        p = get_provider("deepseek")
    assert isinstance(p, DeepSeekProvider)


@pytest.mark.unit
def test_reasoner_strips_tools_before_generate(provider: DeepSeekProvider) -> None:
    """deepseek-reasoner must not receive tool definitions."""
    from llm.core.types import LLMInput, Message, Role, ToolDefinition
    response = MagicMock()
    choice = MagicMock()
    choice.message.content = "answer"
    choice.message.tool_calls = None
    choice.finish_reason = "stop"
    response.choices = [choice]
    response.model = "deepseek-reasoner"
    usage = MagicMock()
    usage.prompt_tokens = 10
    usage.completion_tokens = 5
    usage.total_tokens = 15
    response.usage = usage
    provider.client.chat.completions.create.return_value = response
    llm_input = LLMInput(
        messages=[Message(role=Role.USER, content="hi")],
        model="deepseek-reasoner",
        tools=[ToolDefinition(name="my_tool", description="does stuff", parameters={})],
    )
    provider.generate(llm_input)
    _, kwargs = provider.client.chat.completions.create.call_args
    assert "tools" not in kwargs or kwargs["tools"] is None


@pytest.mark.unit
def test_get_default_model_returns_deepseek_chat_when_resolver_bleeds(monkeypatch: pytest.MonkeyPatch) -> None:
    """get_default_model must not return a non-deepseek model."""
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    with patch("llm.providers.deepseek.OpenAI") as mock_openai, \
         patch("llm.providers.deepseek.ModelResolver.resolve", return_value="gemini-2.5-pro"):
        mock_openai.return_value = MagicMock()
        p = DeepSeekProvider()
    assert p.get_default_model() == "deepseek-chat"
