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
def test_unauthorized_exception_raises_authentication_error(provider: DeepSeekProvider) -> None:
    """Regression test for audit EGC-128 (medium): only the client-side
    missing-key check was covered before this; a real 401 rejection from
    the API itself (the actual OpenAIProvider.generate() classification
    path) had no test for DeepSeek specifically."""
    provider.client.chat.completions.create.side_effect = RuntimeError("401 unauthorized: invalid api key")
    with pytest.raises(AuthenticationError) as exc:
        provider.generate(_simple_input())
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

# ── Tests added for issue #725 ────────────────────────────────────────────────

@pytest.mark.unit
def test_reasoner_forces_temperature_to_one(provider: DeepSeekProvider) -> None:
    """fix #1: deepseek-reasoner must always receive temperature=1.0."""
    from llm.core.types import LLMInput, Message, Role
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
        temperature=0.0,  # non-default — would be rejected by the API
    )
    provider.generate(llm_input)
    _, kwargs = provider.client.chat.completions.create.call_args
    assert kwargs["temperature"] == 1.0


@pytest.mark.unit
def test_reasoner_leaves_temperature_unchanged_when_already_one(provider: DeepSeekProvider) -> None:
    """fix #1: no unnecessary LLMInput rebuild when temperature is already 1.0."""
    from llm.core.types import LLMInput, Message, Role
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
        temperature=1.0,
    )
    provider.generate(llm_input)
    _, kwargs = provider.client.chat.completions.create.call_args
    assert kwargs["temperature"] == 1.0


@pytest.mark.unit
def test_native_sdk_exception_is_retagged_as_deepseek(provider: DeepSeekProvider) -> None:
    """fix #2: raw SDK exceptions that bypass OpenAIProvider wrapping must still
    surface as LLMError with provider=DEEPSEEK, not as bare SDK errors."""
    provider.client.chat.completions.create.side_effect = RuntimeError("connection reset")
    with pytest.raises(LLMError) as exc:
        provider.generate(_simple_input())
    assert exc.value.provider == ProviderType.DEEPSEEK


@pytest.mark.unit
def test_native_sdk_exception_secrets_are_redacted(provider: DeepSeekProvider) -> None:
    """Regression test for audit EGC-128 (medium): a raw SDK exception can
    embed the HTTP response body, which may echo request headers/payloads
    back — that text must not reach LLMError verbatim."""
    provider.client.chat.completions.create.side_effect = RuntimeError(
        'connection failed, request had Authorization: Bearer sk-leaked-value-123456'
    )
    with pytest.raises(LLMError) as exc:
        provider.generate(_simple_input())
    assert "sk-leaked-value-123456" not in str(exc.value)


@pytest.mark.unit
def test_provider_for_deepseek_model_names(monkeypatch: pytest.MonkeyPatch) -> None:
    """fix #3: ModelResolver._provider_for must return 'deepseek' for both
    current and hypothetical future DeepSeek native model names."""
    from llm.core.model_resolver import ModelResolver
    assert ModelResolver._provider_for("deepseek-chat") == "deepseek"
    assert ModelResolver._provider_for("deepseek-reasoner") == "deepseek"
    # Hypothetical future name that doesn't start with "deepseek" won't be
    # caught by this heuristic, but current names must be correct.
    assert ModelResolver._provider_for("gemini-2.5-pro") != "deepseek"


@pytest.mark.unit
def test_model_resolver_default_for_deepseek_provider() -> None:
    """fix #3: ModelResolver.resolve(None, provider='deepseek') must return a
    deepseek model, not bleed into gemini or another provider's default."""
    from llm.core.model_resolver import ModelResolver
    resolved = ModelResolver.resolve(None, provider="deepseek")
    assert ModelResolver._provider_for(resolved) == "deepseek"

# ── Tests added to address cubic-dev-ai P2 review comments ───────────────────

@pytest.mark.unit
def test_resolve_deepseek_reasoner_is_not_replaced_by_default() -> None:
    """P2 fix: deepseek-reasoner passed as a hint must resolve to itself,
    not silently collapse to deepseek-chat via _PROVIDER_DEFAULTS."""
    from llm.core.model_resolver import ModelResolver
    resolved = ModelResolver.resolve("deepseek-reasoner", provider="deepseek")
    assert resolved == "deepseek-reasoner"


@pytest.mark.unit
def test_non_streaming_call_unchanged(provider: DeepSeekProvider) -> None:
    """Regression test for issue #903: the non-streaming path (stream=False,
    the default) must continue to work exactly as before and must not forward
    a `stream` kwarg to the SDK."""
    response = MagicMock()
    choice = MagicMock()
    choice.message.content = "hi"
    choice.message.tool_calls = None
    choice.finish_reason = "stop"
    response.choices = [choice]
    response.model = "deepseek-chat"
    usage = MagicMock()
    usage.prompt_tokens = 1
    usage.completion_tokens = 2
    usage.total_tokens = 3
    response.usage = usage
    provider.client.chat.completions.create.return_value = response

    result = provider.generate(_simple_input())

    assert result.content == "hi"
    _, kwargs = provider.client.chat.completions.create.call_args
    assert "stream" not in kwargs


@pytest.mark.unit
def test_stream_flag_raises_not_implemented(provider: DeepSeekProvider) -> None:
    """Regression test for issue #903: DeepSeekProvider forwards the stream
    flag through the OpenAI-compatible flow. Because streaming is not
    implemented, the request must fail loudly instead of silently
    downgrading to a blocking call."""
    stream_input = LLMInput(
        messages=[Message(role=Role.USER, content="hi")],
        model="deepseek-chat",
        stream=True,
    )

    with pytest.raises(NotImplementedError, match="streaming not supported"):
        provider.generate(stream_input)

    provider.client.chat.completions.create.assert_not_called()


@pytest.mark.unit
def test_bare_deepseek_alias_does_not_claim_deepseek_provider() -> None:
    """P2 fix: the bare token 'deepseek' is an alias, not a model ID.
    _provider_for must not return 'deepseek' for it, so LLM_MODEL=deepseek
    does not bypass the alias resolution path."""
    from llm.core.model_resolver import ModelResolver
    # bare alias token — must NOT be classified as a native deepseek model
    assert ModelResolver._provider_for("deepseek") != "deepseek"
    # real model IDs — must be classified correctly
    assert ModelResolver._provider_for("deepseek-chat") == "deepseek"
    assert ModelResolver._provider_for("deepseek-reasoner") == "deepseek"
