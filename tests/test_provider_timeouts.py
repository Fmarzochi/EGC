"""Tests that every LLM provider passes an explicit timeout to its HTTP client."""

from unittest.mock import patch

import pytest

from llm.core.interface import CLIENT_TIMEOUT


@pytest.mark.unit
def test_openai_provider_timeout():
    with patch("openai.OpenAI") as mock_openai:
        from llm.providers.openai import OpenAIProvider

        OpenAIProvider(api_key="test-key")

        mock_openai.assert_called_once()
        _, kwargs = mock_openai.call_args
        assert kwargs["timeout"] == CLIENT_TIMEOUT


@pytest.mark.unit
def test_claude_provider_timeout():
    anthropic = pytest.importorskip("anthropic", reason="anthropic SDK not installed")
    with patch.object(anthropic, "Anthropic") as mock_anthropic:
        from llm.providers.claude import ClaudeProvider

        ClaudeProvider(api_key="test-key")

        mock_anthropic.assert_called_once()
        _, kwargs = mock_anthropic.call_args
        assert kwargs["timeout"] == CLIENT_TIMEOUT


@pytest.mark.unit
def test_gemini_provider_timeout():
    with patch("llm.providers.gemini.genai") as mock_genai:
        from llm.providers.gemini import GeminiProvider

        GeminiProvider(api_key="test-key")

        mock_genai.Client.assert_called_once()
        _, kwargs = mock_genai.Client.call_args
        assert "http_options" in kwargs
        assert kwargs["http_options"]["timeout"] == int(CLIENT_TIMEOUT * 1000)


@pytest.mark.unit
def test_cohere_provider_timeout():
    with patch("llm.providers.cohere.cohere") as mock_cohere:
        from llm.providers.cohere import CohereProvider

        CohereProvider(api_key="test-key")

        mock_cohere.ClientV2.assert_called_once()
        _, kwargs = mock_cohere.ClientV2.call_args
        assert kwargs["timeout"] == CLIENT_TIMEOUT


@pytest.mark.unit
def test_mistral_provider_timeout():
    with patch("llm.providers.mistral.OpenAI") as mock_openai:
        from llm.providers.mistral import MistralProvider

        MistralProvider(api_key="test-key")

        mock_openai.assert_called_once()
        _, kwargs = mock_openai.call_args
        assert kwargs["timeout"] == CLIENT_TIMEOUT


@pytest.mark.unit
def test_deepseek_provider_timeout():
    with patch("llm.providers.deepseek.OpenAI") as mock_openai:
        from llm.providers.deepseek import DeepSeekProvider

        DeepSeekProvider(api_key="test-key")

        mock_openai.assert_called_once()
        _, kwargs = mock_openai.call_args
        assert kwargs["timeout"] == CLIENT_TIMEOUT


@pytest.mark.unit
def test_groq_provider_timeout():
    with patch("llm.providers.groq.OpenAI") as mock_openai:
        from llm.providers.groq import GroqProvider

        GroqProvider(api_key="test-key")

        mock_openai.assert_called_once()
        _, kwargs = mock_openai.call_args
        assert kwargs["timeout"] == CLIENT_TIMEOUT


@pytest.mark.unit
def test_openrouter_provider_timeout():
    with patch("llm.providers.openrouter.OpenAI") as mock_openai:
        from llm.providers.openrouter import OpenRouterProvider

        OpenRouterProvider(api_key="test-key")

        mock_openai.assert_called_once()
        _, kwargs = mock_openai.call_args
        assert kwargs["timeout"] == CLIENT_TIMEOUT


@pytest.mark.unit
def test_vertex_ai_provider_timeout():
    with patch("llm.providers.vertex_ai.genai") as mock_genai:
        from llm.providers.vertex_ai import VertexAIProvider

        VertexAIProvider(project="test-project")

        mock_genai.Client.assert_called_once()
        _, kwargs = mock_genai.Client.call_args
        assert "http_options" in kwargs
        assert kwargs["http_options"]["timeout"] == int(CLIENT_TIMEOUT * 1000)
