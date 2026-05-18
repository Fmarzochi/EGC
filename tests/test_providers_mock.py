"""Mock-based tests for the 5 provider adapters.

These tests patch each provider's optional SDK at the module level so the
adapter layer can be exercised in CI without real API keys or installed
SDK packages. They verify that:

  - The provider constructor succeeds when its SDK is available.
  - generate() routes through the expected SDK client method.
  - The adapter correctly extracts response text from a mocked SDK return.
"""

from __future__ import annotations

import json
import sys
import types as _pytypes
from unittest.mock import MagicMock, patch

import pytest

from llm.core.types import LLMInput, Message, Role


def _basic_input(model: str | None = None) -> LLMInput:
    return LLMInput(
        messages=[Message(role=Role.USER, content="hello")],
        model=model,
        temperature=0.0,
        max_tokens=16,
    )


def _install_fake_genai_module() -> _pytypes.ModuleType:
    """Build a minimal fake ``google.genai`` namespace usable by the adapter."""
    fake_genai = _pytypes.ModuleType("google.genai")

    class _FakeType:
        OBJECT = "OBJECT"
        ARRAY = "ARRAY"
        STRING = "STRING"
        INTEGER = "INTEGER"
        NUMBER = "NUMBER"
        BOOLEAN = "BOOLEAN"

    class _FakePart:
        def __init__(self, text: str = "", function_call=None):
            self.text = text
            self.function_call = function_call

        @classmethod
        def from_text(cls, text: str):
            return cls(text=text)

        @classmethod
        def from_function_call(cls, name: str, args):
            return cls(function_call=MagicMock(name=name, args=args))

        @classmethod
        def from_function_response(cls, name: str, response):
            return cls(text=json.dumps({"name": name, "response": response}))

    class _FakeContent:
        def __init__(self, role: str, parts):
            self.role = role
            self.parts = parts

    class _FakeSchema:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class _FakeFunctionDeclaration:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class _FakeTool:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class _FakeGenerateContentConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    fake_types = _pytypes.SimpleNamespace(
        Type=_FakeType,
        Part=_FakePart,
        Content=_FakeContent,
        Schema=_FakeSchema,
        FunctionDeclaration=_FakeFunctionDeclaration,
        Tool=_FakeTool,
        GenerateContentConfig=_FakeGenerateContentConfig,
        FinishReason=str,
    )

    fake_genai.types = fake_types

    class _FakeClient:
        def __init__(self, api_key: str | None = None):
            self.api_key = api_key
            self.models = MagicMock()

    fake_genai.Client = _FakeClient

    fake_errors = _pytypes.SimpleNamespace(APIError=Exception)
    fake_genai.errors = fake_errors

    return fake_genai


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------


def test_gemini_provider_instantiates_with_api_key():
    fake_genai = _install_fake_genai_module()
    with patch("llm.providers.gemini.genai", fake_genai), \
         patch("llm.providers.gemini.types", fake_genai.types), \
         patch("llm.providers.gemini.APIError", Exception):
        from llm.providers.gemini import GeminiProvider
        provider = GeminiProvider(api_key="fake-key")
        assert provider.client is not None
        assert provider.client.api_key == "fake-key"
        assert provider.validate_config() is True


def test_gemini_provider_generate_routes_to_models_generate_content():
    fake_genai = _install_fake_genai_module()
    with patch("llm.providers.gemini.genai", fake_genai), \
         patch("llm.providers.gemini.types", fake_genai.types), \
         patch("llm.providers.gemini.APIError", Exception):
        from llm.providers.gemini import GeminiProvider
        provider = GeminiProvider(api_key="fake-key")

        fake_part = MagicMock()
        fake_part.text = "hi there"
        fake_part.function_call = None
        fake_candidate = MagicMock()
        fake_candidate.content.parts = [fake_part]
        fake_candidate.finish_reason = "STOP"
        fake_response = MagicMock()
        fake_response.candidates = [fake_candidate]
        fake_response.usage_metadata.prompt_token_count = 3
        fake_response.usage_metadata.candidates_token_count = 2

        provider.client.models.generate_content = MagicMock(return_value=fake_response)

        out = provider.generate(_basic_input(model="gemini-2.5-flash"))

        assert provider.client.models.generate_content.called
        call_kwargs = provider.client.models.generate_content.call_args.kwargs
        assert call_kwargs["model"] == "gemini-2.5-flash"
        assert out.content == "hi there"
        assert out.usage == {"input_tokens": 3, "output_tokens": 2}
        assert out.stop_reason == "end_turn"


# ---------------------------------------------------------------------------
# Claude
# ---------------------------------------------------------------------------


def test_claude_provider_instantiates_with_api_key():
    fake_anthropic_cls = MagicMock()
    fake_client = MagicMock()
    fake_client.api_key = "fake-key"
    fake_anthropic_cls.return_value = fake_client
    with patch("llm.providers.claude.Anthropic", fake_anthropic_cls):
        from llm.providers.claude import ClaudeProvider
        provider = ClaudeProvider(api_key="fake-key")
        assert provider.client is fake_client
        assert provider.validate_config() is True
        fake_anthropic_cls.assert_called_once()
        kwargs = fake_anthropic_cls.call_args.kwargs
        assert kwargs.get("api_key") == "fake-key"


def test_claude_provider_generate_routes_to_messages_create():
    fake_anthropic_cls = MagicMock()
    fake_client = MagicMock()
    fake_client.api_key = "fake-key"

    fake_text_block = MagicMock()
    fake_text_block.type = "text"
    fake_text_block.text = "hi from claude"
    fake_response = MagicMock()
    fake_response.content = [fake_text_block]
    fake_response.model = "claude-sonnet-4-7"
    fake_response.usage.input_tokens = 5
    fake_response.usage.output_tokens = 4
    fake_response.stop_reason = "end_turn"
    fake_client.messages.create.return_value = fake_response

    fake_anthropic_cls.return_value = fake_client

    with patch("llm.providers.claude.Anthropic", fake_anthropic_cls):
        from llm.providers.claude import ClaudeProvider
        provider = ClaudeProvider(api_key="fake-key")
        out = provider.generate(_basic_input(model="claude-sonnet-4-7"))

        fake_client.messages.create.assert_called_once()
        call_kwargs = fake_client.messages.create.call_args.kwargs
        assert call_kwargs["model"] == "claude-sonnet-4-7"
        assert call_kwargs["messages"][0]["role"] == "user"
        assert out.content == "hi from claude"
        assert out.usage == {"input_tokens": 5, "output_tokens": 4}
        assert out.stop_reason == "end_turn"


# ---------------------------------------------------------------------------
# OpenAI
# ---------------------------------------------------------------------------


def test_openai_provider_instantiates_with_api_key():
    fake_openai_cls = MagicMock()
    fake_client = MagicMock()
    fake_client.api_key = "fake-key"
    fake_openai_cls.return_value = fake_client
    with patch("llm.providers.openai.OpenAI", fake_openai_cls):
        from llm.providers.openai import OpenAIProvider
        provider = OpenAIProvider(api_key="fake-key")
        assert provider.client is fake_client
        assert provider.validate_config() is True
        fake_openai_cls.assert_called_once()


def test_openai_provider_generate_routes_to_chat_completions_create():
    fake_openai_cls = MagicMock()
    fake_client = MagicMock()
    fake_client.api_key = "fake-key"

    fake_choice = MagicMock()
    fake_choice.message.content = "hi from openai"
    fake_choice.message.tool_calls = None
    fake_choice.finish_reason = "stop"
    fake_response = MagicMock()
    fake_response.choices = [fake_choice]
    fake_response.model = "gpt-4o-mini"
    fake_response.usage.prompt_tokens = 7
    fake_response.usage.completion_tokens = 3
    fake_response.usage.total_tokens = 10
    fake_client.chat.completions.create.return_value = fake_response

    fake_openai_cls.return_value = fake_client

    with patch("llm.providers.openai.OpenAI", fake_openai_cls):
        from llm.providers.openai import OpenAIProvider
        provider = OpenAIProvider(api_key="fake-key")
        out = provider.generate(_basic_input(model="gpt-4o-mini"))

        fake_client.chat.completions.create.assert_called_once()
        call_kwargs = fake_client.chat.completions.create.call_args.kwargs
        assert call_kwargs["model"] == "gpt-4o-mini"
        assert call_kwargs["messages"][0]["content"] == "hello"
        assert out.content == "hi from openai"
        assert out.stop_reason == "stop"
        assert out.usage["total_tokens"] == 10


# ---------------------------------------------------------------------------
# OpenRouter (reuses the OpenAI transport)
# ---------------------------------------------------------------------------


def test_openrouter_provider_instantiates():
    fake_openai_cls = MagicMock()
    fake_client = MagicMock()
    fake_client.api_key = "fake-or-key"
    fake_openai_cls.return_value = fake_client
    with patch("llm.providers.openrouter.OpenAI", fake_openai_cls):
        from llm.providers.openrouter import OpenRouterProvider
        provider = OpenRouterProvider(api_key="fake-or-key")
        assert provider.client is fake_client
        assert provider.validate_config() is True


def test_openrouter_uses_openrouter_base_url(monkeypatch):
    monkeypatch.delenv("OPENROUTER_BASE_URL", raising=False)
    fake_openai_cls = MagicMock()
    fake_client = MagicMock()
    fake_client.api_key = "fake-or-key"
    fake_openai_cls.return_value = fake_client
    with patch("llm.providers.openrouter.OpenAI", fake_openai_cls):
        from llm.providers.openrouter import OpenRouterProvider, OPENROUTER_BASE_URL
        OpenRouterProvider(api_key="fake-or-key")
        fake_openai_cls.assert_called_once()
        kwargs = fake_openai_cls.call_args.kwargs
        assert kwargs.get("base_url") == OPENROUTER_BASE_URL
        assert kwargs.get("api_key") == "fake-or-key"


# ---------------------------------------------------------------------------
# Ollama (no SDK; uses urllib directly)
# ---------------------------------------------------------------------------


def test_ollama_provider_instantiates():
    from llm.providers.ollama import OllamaProvider
    provider = OllamaProvider(base_url="http://localhost:11434", default_model="llama3.2")
    assert provider.base_url == "http://localhost:11434"
    assert provider.default_model == "llama3.2"
    assert provider.validate_config() is True
    assert provider.get_default_model() == "llama3.2"


def test_ollama_provider_uses_configured_base_url():
    from llm.providers.ollama import OllamaProvider
    provider = OllamaProvider(base_url="http://example.invalid:9999", default_model="llama3.2")

    fake_resp_body = json.dumps({
        "message": {"content": "hi from ollama"},
        "done_reason": "stop",
    }).encode("utf-8")

    class _FakeHTTPResponse:
        def __init__(self, body: bytes):
            self._body = body

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    captured = {}

    def _fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["data"] = req.data
        return _FakeHTTPResponse(fake_resp_body)

    with patch("urllib.request.urlopen", _fake_urlopen):
        out = provider.generate(_basic_input(model="llama3.2"))

    assert captured["url"].startswith("http://example.invalid:9999")
    assert out.content == "hi from ollama"
    assert out.stop_reason == "stop"
    assert out.model == "llama3.2"
