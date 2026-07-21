"""Tests for VertexAIProvider."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from llm.core.interface import CLIENT_TIMEOUT, AuthenticationError, LLMError
from llm.core.types import LLMInput, Message, ProviderType, Role
from llm.providers import gemini as gemini_module
from llm.providers.vertex_ai import VertexAIProvider


class _PartStub:
    @staticmethod
    def from_text(text: str | None) -> SimpleNamespace:
        if text is None:
            raise TypeError("argument of type 'NoneType' is not iterable")
        return SimpleNamespace(text=text, function_call=None)


class _TypesStub:
    Part = _PartStub
    Content = SimpleNamespace
    GenerateContentConfig = SimpleNamespace


def _simple_input() -> LLMInput:
    return LLMInput(
        messages=[Message(role=Role.USER, content="hi")],
        model="gemini-2.5-pro",
    )


def _gemini_response(text: str = "ok") -> SimpleNamespace:
    part = SimpleNamespace(text=text, function_call=None)
    content = SimpleNamespace(parts=[part])
    candidate = SimpleNamespace(content=content, finish_reason="STOP")
    return SimpleNamespace(candidates=[candidate], usage_metadata=None)


@pytest.fixture
def provider() -> VertexAIProvider:
    """Build a VertexAIProvider with a mocked genai client — no real SDK calls."""
    p = VertexAIProvider.__new__(VertexAIProvider)
    p.client = MagicMock()
    p._project = "test-project"
    p._location = "us-central1"
    p._fallback_chain = {}
    p._models = []
    return p


@pytest.mark.unit
def test_provider_type_is_vertex_ai(provider: VertexAIProvider) -> None:
    assert provider.provider_type == ProviderType.VERTEX_AI


@pytest.mark.unit
def test_missing_project_raises_authentication_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    with patch("llm.providers.vertex_ai.genai") as mock_genai:
        mock_genai.Client.return_value = MagicMock()
        with pytest.raises(AuthenticationError) as exc:
            VertexAIProvider(project=None)
    assert exc.value.provider == ProviderType.VERTEX_AI


@pytest.mark.unit
def test_project_and_location_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "my-gcp-project")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "europe-west4")
    with patch("llm.providers.vertex_ai.genai") as mock_genai:
        mock_genai.Client.return_value = MagicMock()
        provider = VertexAIProvider()
    mock_genai.Client.assert_called_once_with(
        vertexai=True,
        project="my-gcp-project",
        location="europe-west4",
        http_options={"timeout": int(CLIENT_TIMEOUT * 1000)},
    )
    assert provider._project == "my-gcp-project"
    assert provider._location == "europe-west4"


@pytest.mark.unit
def test_location_defaults_to_us_central1(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "my-gcp-project")
    monkeypatch.delenv("GOOGLE_CLOUD_LOCATION", raising=False)
    with patch("llm.providers.vertex_ai.genai") as mock_genai:
        mock_genai.Client.return_value = MagicMock()
        provider = VertexAIProvider()
    assert provider._location == "us-central1"


@pytest.mark.unit
def test_explicit_project_overrides_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "env-project")
    with patch("llm.providers.vertex_ai.genai") as mock_genai:
        mock_genai.Client.return_value = MagicMock()
        provider = VertexAIProvider(project="explicit-project")
    assert provider._project == "explicit-project"


@pytest.mark.unit
def test_list_models_reports_vertex_ai_not_gemini(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression test for audit EGC-128 (medium): model_infos("gemini") is
    reused for the shared catalog, but each ModelInfo comes back tagged
    provider=GEMINI from the registry. Any usage/cost telemetry grouping by
    ModelInfo.provider must see VERTEX_AI, not GEMINI, for Vertex traffic."""
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "my-gcp-project")
    with patch("llm.providers.vertex_ai.genai") as mock_genai:
        mock_genai.Client.return_value = MagicMock()
        provider = VertexAIProvider()

    models = provider.list_models()
    assert len(models) > 0
    assert all(m.provider == ProviderType.VERTEX_AI for m in models)


@pytest.mark.unit
def test_validate_config_true_when_project_and_location_set(
    provider: VertexAIProvider,
) -> None:
    assert provider.validate_config() is True


@pytest.mark.unit
def test_validate_config_false_when_no_project(provider: VertexAIProvider) -> None:
    provider._project = None
    assert provider.validate_config() is False


@pytest.mark.unit
def test_validate_config_false_when_no_location(provider: VertexAIProvider) -> None:
    provider._location = None
    assert provider.validate_config() is False


@pytest.mark.unit
def test_generate_returns_text_via_shared_gemini_logic(
    provider: VertexAIProvider,
) -> None:
    """generate() reuses GeminiProvider's message/response handling."""
    with patch.object(gemini_module, "types", _TypesStub):
        provider.client.models.generate_content.return_value = _gemini_response(
            "hello vertex"
        )
        result = provider.generate(_simple_input())
    assert result.content == "hello vertex"


@pytest.mark.unit
def test_empty_choices_style_error_is_retagged_as_vertex_ai(
    provider: VertexAIProvider,
) -> None:
    """Errors raised by the inherited generate() must be re-tagged to VERTEX_AI,
    not left as GEMINI, while preserving the original exception subclass."""
    with patch.object(gemini_module, "types", _TypesStub):
        provider.client.models.generate_content.side_effect = RuntimeError(
            "401 unauthorized"
        )
        with pytest.raises(LLMError) as exc:
            provider.generate(_simple_input())
    assert exc.value.provider == ProviderType.VERTEX_AI
    assert isinstance(exc.value, AuthenticationError)


@pytest.mark.unit
def test_vertex_ai_in_provider_type_enum() -> None:
    assert ProviderType("vertex_ai") == ProviderType.VERTEX_AI


@pytest.mark.unit
def test_get_provider_resolves_vertex_ai(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "my-gcp-project")
    from llm.providers.resolver import get_provider

    with patch("llm.providers.vertex_ai.genai") as mock_genai:
        mock_genai.Client.return_value = MagicMock()
        p = get_provider("vertex_ai")
    assert isinstance(p, VertexAIProvider)


@pytest.mark.unit
def test_get_default_model_reuses_gemini_catalog(provider: VertexAIProvider) -> None:
    """Vertex AI serves the same Gemini model family; get_default_model()
    must not return a hardcoded or separate model ID."""
    from llm.core.model_resolver import ModelResolver

    assert provider.get_default_model() == ModelResolver.resolve(
        None, provider="gemini"
    )
