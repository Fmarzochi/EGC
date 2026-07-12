"""Tests for MistralProvider content extraction and model resolution integration."""

import sys
import types
import unittest
from unittest.mock import MagicMock, patch

from llm.core.interface import LLMError
from llm.core.model_resolver import ModelResolver, ModelCapability
from llm.core.types import ProviderType


def _make_mistral_stub():
    stub = types.ModuleType("mistralai")
    stub.Mistral = MagicMock
    stub.MistralClient = MagicMock
    return stub


def _simple_input():
    from llm.core.types import LLMInput, Message, Role
    return LLMInput(
        messages=[Message(role=Role.USER, content="hi")],
        model="mistral-large-latest",
    )


class TestMistralProviderIntegration(unittest.TestCase):
    def setUp(self):
        self._patch = patch.dict(sys.modules, {"mistralai": _make_mistral_stub()})
        self._patch.start()
        from llm.providers.mistral import MistralProvider
        
        self.provider = MistralProvider.__new__(MistralProvider)
        
        # Build out standard chat.completions.create structure hierarchy
        self.provider.client = MagicMock()
        self.mock_create = MagicMock()
        self.provider.client.chat.completions.create = self.mock_create
        
        self.provider._models = []

    def tearDown(self):
        self._patch.stop()

    def _make_response(self, choices, stop_reason="stop"):
        response = MagicMock()
        response.choices = choices
        response.model = "mistral-large-latest"
        response.usage.prompt_tokens = 10
        response.usage.completion_tokens = 5
        return response

    def _text_choice(self, text, index=0):
        choice = MagicMock()
        choice.index = index
        choice.message.role = "assistant"
        choice.message.content = text
        choice.message.tool_calls = None
        choice.finish_reason = "stop"
        return choice

    def _tool_choice(self, name="some_tool", tool_id="call_1", arguments=None, index=0):
        choice = MagicMock()
        choice.index = index
        choice.message.role = "assistant"
        choice.message.content = ""
        choice.finish_reason = "tool_calls"
        
        # Build out a specific tool call instance structure
        tool_call = MagicMock()
        tool_call.id = tool_id
        tool_call.type = "function"
        
        # Explicitly configure function properties so they return strings instead of fresh mocks
        func_mock = MagicMock()
        func_mock.name = name
        func_mock.arguments = arguments or '{"key": "value"}'
        
        tool_call.function = func_mock
        choice.message.tool_calls = [tool_call]
        return choice

    # --- Content Extraction Tests ---

    def test_text_response_returns_content(self):
        self.mock_create.return_value = self._make_response(
            [self._text_choice("hello mistral")]
        )
        result = self.provider.generate(_simple_input())
        self.assertEqual(result.content, "hello mistral")

    def test_tool_use_extracts_calls_properly(self):
        self.mock_create.return_value = self._make_response(
            [self._tool_choice("calculator", "call_99", '{"expr": "2+2"}')],
            stop_reason="tool_calls"
        )
        result = self.provider.generate(_simple_input())
        self.assertIsNotNone(result.tool_calls)
        self.assertEqual(result.tool_calls[0].name, "calculator")
        self.assertIn("2+2", str(result.tool_calls[0].arguments))

    def test_empty_choices_raise_llm_error(self):
        self.mock_create.return_value = self._make_response([])
        with self.assertRaises(LLMError) as context:
            self.provider.generate(_simple_input())
        
        self.assertEqual(context.exception.provider, ProviderType.MISTRAL)
        self.assertIn("empty choices", str(context.exception))

    # --- Configuration Tests ---

    def test_validate_config_true(self):
        self.provider.client.api_key = "valid-key"
        self.assertTrue(self.provider.validate_config())

    def test_validate_config_false(self):
        self.provider.client.api_key = None
        self.assertFalse(self.provider.validate_config())

    # --- Core Resolver Capability Verification Tests ---

    def test_resolver_mistral_metadata(self):
        info = ModelResolver.get_model_info("mistral-large-latest")
        self.assertEqual(info["provider"], "mistral")
        self.assertEqual(info["context_window"], 128000)
        self.assertEqual(info["max_tokens"], 8192)
        self.assertTrue(info["supports_vision"])
        self.assertTrue(info["supports_tools"])
        self.assertIn(ModelCapability.REASONING, info["capabilities"])

    def test_resolver_mistral_aliases(self):
        self.assertEqual(ModelResolver.resolve("mistral"), "mistral-large-latest")
        self.assertEqual(ModelResolver.resolve("mistral-large-latest"), "mistral-large-latest")
        self.assertEqual(ModelResolver.default_model(provider="mistral"), "mistral-large-latest")

    def test_resolver_menu_and_strategy(self):
        choices = ModelResolver.menu_choices(provider="mistral")
        self.assertEqual(len(choices), 1)
        self.assertEqual(choices[0][0], "mistral-large-latest")
        
        desc = ModelResolver.describe_strategy(model_hint="mistral")
        self.assertEqual(desc["provider"], "Mistral AI")
        self.assertEqual(desc["provider_id"], "mistral")


if __name__ == "__main__":
    unittest.main()