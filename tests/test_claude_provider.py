"""Tests for ClaudeProvider content extraction."""

import sys
import types
import unittest
from unittest.mock import MagicMock, patch


def _make_anthropic_stub():
    stub = types.ModuleType("anthropic")
    stub.Anthropic = MagicMock
    return stub


def _simple_input():
    from llm.core.types import LLMInput, Message, Role
    return LLMInput(
        messages=[Message(role=Role.USER, content="hi")],
        model="claude-sonnet-4-7",
    )


class TestClaudeProviderContentExtraction(unittest.TestCase):
    def setUp(self):
        self._patch = patch.dict(sys.modules, {"anthropic": _make_anthropic_stub()})
        self._patch.start()
        from llm.providers.claude import ClaudeProvider
        self.provider = ClaudeProvider.__new__(ClaudeProvider)
        self.provider.client = MagicMock()
        self.provider._models = []

    def tearDown(self):
        self._patch.stop()

    def _make_response(self, blocks, stop_reason="end_turn"):
        response = MagicMock()
        response.content = blocks
        response.model = "claude-sonnet-4-7"
        response.stop_reason = stop_reason
        response.usage.input_tokens = 10
        response.usage.output_tokens = 5
        return response

    def _text_block(self, text):
        block = MagicMock()
        block.type = "text"
        block.text = text
        return block

    def _tool_block(self, name="some_tool", tool_id="call_1"):
        block = MagicMock()
        block.type = "tool_use"
        block.id = tool_id
        block.name = name
        block.configure_mock(input={"key": "value"})
        return block

    def test_text_block_returns_text_content(self):
        self.provider.client.messages.create.return_value = self._make_response(
            [self._text_block("hello")]
        )
        result = self.provider.generate(_simple_input())
        self.assertEqual(result.content, "hello")

    def test_tool_use_first_returns_empty_content(self):
        """Regression: tool_use block has no .text — must not raise AttributeError."""
        self.provider.client.messages.create.return_value = self._make_response(
            [self._tool_block()], stop_reason="tool_use"
        )
        result = self.provider.generate(_simple_input())
        self.assertEqual(result.content, "")
        self.assertIsNotNone(result.tool_calls)
        self.assertEqual(result.tool_calls[0].arguments, {"key": "value"})

    def test_tool_use_then_text_extracts_text(self):
        """Text after a tool_use block must be returned, not skipped."""
        self.provider.client.messages.create.return_value = self._make_response(
            [self._tool_block(), self._text_block("done")]
        )
        result = self.provider.generate(_simple_input())
        self.assertEqual(result.content, "done")

    def test_empty_content_returns_empty_string(self):
        self.provider.client.messages.create.return_value = self._make_response([])
        result = self.provider.generate(_simple_input())
        self.assertEqual(result.content, "")


if __name__ == "__main__":
    unittest.main()
