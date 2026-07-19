"""Tests for GroqProvider."""
from unittest.mock import MagicMock, patch
import pytest
from llm.core.interface import AuthenticationError, LLMError
from llm.core.types import LLMInput, Message, ProviderType, Role
from llm.providers.groq import GROQ_BASE_URL, GroqProvider


def _simple_input() -> LLMInput:
    return LLMInput(
        messages=[Message(role=Role.USER, content="hi")],
        model="openai/gpt-oss-120b",
    )


@pytest.fixture
def provider() -> GroqProvider:
    p = GroqProvider.__new__(GroqProvider)
    p.client = MagicMock()
    p._models = []
    return p


@pytest.mark.unit
def test_provider_type_is_groq(provider: GroqProvider) -> None:
    assert provider.provider_type == ProviderType.GROQ


@pytest.mark.unit
def test_missing_api_key_raises_authentication_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with pytest.raises(AuthenticationError) as exc:
        GroqProvider(api_key=None)
    assert exc.value.provider == ProviderType.GROQ


@pytest.mark.unit
def test_unauthorized_exception_raises_authentication_error(provider: GroqProvider) -> None:
    """Regression test for audit EGC-128 (medium): only the client-side
    missing-key check was covered before this; a real 401 rejection from
    the API itself had no test for Groq specifically."""
    provider.client.chat.completions.create.side_effect = RuntimeError("401 unauthorized: invalid api key")
    with pytest.raises(AuthenticationError) as exc:
        provider.generate(_simple_input())
    assert exc.value.provider == ProviderType.GROQ


@pytest.mark.unit
def test_api_key_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GROQ_API_KEY", "gsk-test-key")
    with patch("llm.providers.groq.OpenAI") as mock_openai:
        mock_openai.return_value = MagicMock()
        provider = GroqProvider()
    mock_openai.assert_called_once()
    _, kwargs = mock_openai.call_args
    assert kwargs["api_key"] == "gsk-test-key"
    assert kwargs["base_url"] == GROQ_BASE_URL


@pytest.mark.unit
def test_custom_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GROQ_API_KEY", "gsk-test")
    with patch("llm.providers.groq.OpenAI") as mock_openai:
        mock_openai.return_value = MagicMock()
        GroqProvider(base_url="https://custom.groq.local/v1")
    _, kwargs = mock_openai.call_args
    assert kwargs["base_url"] == "https://custom.groq.local/v1"


@pytest.mark.unit
def test_base_url_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GROQ_API_KEY", "gsk-test")
    monkeypatch.setenv("GROQ_BASE_URL", "https://proxy.internal/v1")
    with patch("llm.providers.groq.OpenAI") as mock_openai:
        mock_openai.return_value = MagicMock()
        GroqProvider()
    _, kwargs = mock_openai.call_args
    assert kwargs["base_url"] == "https://proxy.internal/v1"


@pytest.mark.unit
def test_list_models_returns_copy(provider: GroqProvider) -> None:
    provider._models = [MagicMock()]
    result = provider.list_models()
    assert result is not provider._models


@pytest.mark.unit
def test_validate_config_true_when_key_set(provider: GroqProvider) -> None:
    provider.client.api_key = "gsk-test"
    assert provider.validate_config() is True


@pytest.mark.unit
def test_validate_config_false_when_no_key(provider: GroqProvider) -> None:
    provider.client.api_key = None
    assert provider.validate_config() is False


@pytest.mark.unit
def test_default_models_include_gpt_oss_120b(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GROQ_API_KEY", "gsk-test")
    with patch("llm.providers.groq.OpenAI") as mock_openai, \
         patch("llm.providers.groq.ModelResolver.model_infos", return_value=None):
        mock_openai.return_value = MagicMock()
        p = GroqProvider()
    names = [m.name for m in p._models]
    assert "openai/gpt-oss-120b" in names


@pytest.mark.unit
def test_empty_choices_raises_llm_error(provider: GroqProvider) -> None:
    response = MagicMock()
    response.choices = []
    provider.client.chat.completions.create.return_value = response
    with pytest.raises(LLMError) as exc:
        provider.generate(_simple_input())
    assert exc.value.provider == ProviderType.GROQ


@pytest.mark.unit
def test_groq_in_provider_type_enum() -> None:
    assert ProviderType("groq") == ProviderType.GROQ


@pytest.mark.unit
def test_get_provider_resolves_groq(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GROQ_API_KEY", "gsk-test")
    from llm.providers.resolver import get_provider
    with patch("llm.providers.groq.OpenAI") as mock_openai:
        mock_openai.return_value = MagicMock()
        p = get_provider("groq")
    assert isinstance(p, GroqProvider)


@pytest.mark.unit
def test_get_default_model_returns_groq_model_when_resolver_bleeds(monkeypatch: pytest.MonkeyPatch) -> None:
    """get_default_model must not return a non-groq model."""
    monkeypatch.setenv("GROQ_API_KEY", "gsk-test")
    with patch("llm.providers.groq.OpenAI") as mock_openai, \
         patch("llm.providers.groq.ModelResolver.resolve", return_value="gemini-2.5-pro"):
        mock_openai.return_value = MagicMock()
        p = GroqProvider()
    assert p.get_default_model() == "openai/gpt-oss-120b"


@pytest.mark.unit
def test_native_sdk_exception_is_retagged_as_groq(provider: GroqProvider) -> None:
    """Raw SDK exceptions that bypass OpenAIProvider wrapping must still
    surface as LLMError with provider=GROQ, not as bare SDK errors."""
    provider.client.chat.completions.create.side_effect = RuntimeError("connection reset")
    with pytest.raises(LLMError) as exc:
        provider.generate(_simple_input())
    assert exc.value.provider == ProviderType.GROQ


@pytest.mark.unit
def test_retagging_preserves_exception_subclass(provider: GroqProvider) -> None:
    """Regression test for audit EGC-128 F4: re-tagging an already-typed
    LLMError (AuthenticationError, RateLimitError, ...) by constructing a
    new plain LLMError(str(exc), provider=...) discards the subclass. The
    fix mutates .provider on the original exception and re-raises it, so
    the subclass — and anything a caller might match on via
    except AuthenticationError — survives re-tagging."""
    provider.client.chat.completions.create.side_effect = Exception("401 Unauthorized")
    with pytest.raises(AuthenticationError) as exc:
        provider.generate(_simple_input())
    assert exc.value.provider == ProviderType.GROQ


@pytest.mark.unit
def test_stream_flag_raises_not_implemented(provider: GroqProvider) -> None:
    """Regression test for issue #903: GroqProvider inherits the OpenAI-compatible
    flow, so LLMInput.stream=True must fail loudly instead of being swallowed
    by the provider-retagging wrapper and re-raised as a generic LLMError."""
    stream_input = LLMInput(
        messages=[Message(role=Role.USER, content="hi")],
        model="openai/gpt-oss-120b",
        stream=True,
    )

    with pytest.raises(NotImplementedError, match="streaming not supported"):
        provider.generate(stream_input)

    provider.client.chat.completions.create.assert_not_called()


@pytest.mark.unit
def test_provider_for_groq_model_name() -> None:
    from llm.core.model_resolver import ModelResolver
    assert ModelResolver._provider_for("openai/gpt-oss-120b") == "groq"


@pytest.mark.unit
def test_model_resolver_default_for_groq_provider() -> None:
    """ModelResolver.resolve(None, provider='groq') must return a groq model,
    not bleed into gemini or another provider's default."""
    from llm.core.model_resolver import ModelResolver
    resolved = ModelResolver.resolve(None, provider="groq")
    assert ModelResolver._provider_for(resolved) == "groq"
