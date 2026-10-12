"""Tests for the provider resolver's fallback when a model hint names no provider."""

import logging
from unittest.mock import patch

import pytest

from llm.core.model_resolver import ModelResolver
from llm.core.types import ProviderType
from llm.providers import resolver


class _FakeProvider:
    def __init__(self, **kwargs: str) -> None:
        self.kwargs = kwargs


@pytest.mark.unit
def test_unrecognized_model_falls_back_to_gemini_with_a_warning(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    with caplog.at_level(logging.WARNING, logger="llm.providers.resolver"):
        assert resolver._provider_from_hint("llama-3.3-70b-versatile") == "gemini"
    assert "llama-3.3-70b-versatile" in caplog.text
    assert "falling back to 'gemini'" in caplog.text


@pytest.mark.unit
def test_unrecognized_model_falls_back_to_llm_provider_when_set(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "Groq")
    with caplog.at_level(logging.WARNING, logger="llm.providers.resolver"):
        assert resolver._provider_from_hint("llama-3.3-70b-versatile") == "groq"
    assert "falling back to 'groq'" in caplog.text


@pytest.mark.unit
def test_recognized_model_resolves_without_a_warning(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="llm.providers.resolver"):
        assert resolver._provider_from_hint("claude-sonnet-4-5") == "claude"
        assert resolver._provider_from_hint("deepseek-flash") == "deepseek"
        assert resolver._provider_from_hint("meta-llama/llama-3-70b") == "openrouter"
    assert caplog.text == ""


@pytest.mark.unit
def test_a_resolver_error_falls_back_with_the_error_in_the_warning(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    with (
        patch.object(ModelResolver, "provider_of", side_effect=ValueError("catalog unreadable")),
        caplog.at_level(logging.WARNING, logger="llm.providers.resolver"),
    ):
        assert resolver._provider_from_hint("any-model") == "gemini"
    assert "ValueError('catalog unreadable')" in caplog.text
    assert "Traceback" in caplog.text


@pytest.mark.unit
def test_provider_of_names_the_provider_or_returns_none() -> None:
    assert ModelResolver.provider_of("claude-sonnet-4-5") == "claude"
    assert ModelResolver.provider_of("meta-llama/llama-3-70b") == "openrouter"
    assert ModelResolver.provider_of("llama-3.3-70b-versatile") is None
    assert ModelResolver._provider_for("llama-3.3-70b-versatile") == "gemini"
    assert ModelResolver._provider_for("llama-3.3-70b-versatile", expected="groq") == "groq"


@pytest.mark.unit
def test_get_provider_builds_the_fallback_provider_and_says_so(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.setitem(resolver._PROVIDER_MAP, ProviderType.GEMINI, _FakeProvider)
    with caplog.at_level(logging.WARNING, logger="llm.providers.resolver"):
        provider = resolver.get_provider(model="llama-3.3-70b-versatile")
    assert isinstance(provider, _FakeProvider)
    assert provider.kwargs == {"model": "llama-3.3-70b-versatile"}
    assert "No provider recognizes model 'llama-3.3-70b-versatile'" in caplog.text


@pytest.mark.unit
def test_get_provider_without_a_hint_uses_the_default_quietly(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.setitem(resolver._PROVIDER_MAP, ProviderType.GEMINI, _FakeProvider)
    with caplog.at_level(logging.WARNING, logger="llm.providers.resolver"):
        assert isinstance(resolver.get_provider(), _FakeProvider)
    assert caplog.text == ""
