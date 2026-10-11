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

    def _tool_block(self, name="some_tool", tool_id="call_1", arguments=None):
        block = MagicMock()
        block.type = "tool_use"
        block.id = tool_id
        block.name = name
        block.configure_mock(input=arguments or {"key": "value"})
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

    def test_multiple_tool_use_blocks_are_collected(self):
        self.provider.client.messages.create.return_value = self._make_response(
            [
                self._tool_block("first_tool", "call_1", {"first": "value"}),
                self._tool_block("second_tool", "call_2", {"second": "value"}),
            ],
            stop_reason="tool_use",
        )
        result = self.provider.generate(_simple_input())
        self.assertIsNotNone(result.tool_calls)
        self.assertEqual(
            [tc.name for tc in result.tool_calls],
            ["first_tool", "second_tool"],
        )
        self.assertEqual(
            [tc.arguments for tc in result.tool_calls],
            [{"first": "value"}, {"second": "value"}],
        )

    def test_empty_content_returns_empty_string(self):
        self.provider.client.messages.create.return_value = self._make_response([])
        result = self.provider.generate(_simple_input())
        self.assertEqual(result.content, "")

    def _tool_conversation(self, tool_messages=None):
        from llm.core.types import LLMInput, Message, Role, ToolCall

        results = tool_messages or [Message(role=Role.TOOL, content="sunny", tool_call_id="call_1")]
        # The assistant turn declares one tool call per result that follows,
        # so the fixture is a valid exchange whatever the number of results.
        calls = [
            ToolCall(id=result.tool_call_id, name="weather", arguments={"city": "Rio"})
            for result in results
        ]
        return LLMInput(
            messages=[
                Message(role=Role.SYSTEM, content="be brief"),
                Message(role=Role.USER, content="weather?"),
                Message(role=Role.ASSISTANT, content="checking", tool_calls=calls),
                *results,
            ],
            model="claude-sonnet-4-7",
        )

    def _request_params(self, llm_input):
        self.provider.client.messages.create.return_value = self._make_response([self._text_block("ok")])
        self.provider.generate(llm_input)
        return self.provider.client.messages.create.call_args.kwargs

    def test_system_message_is_sent_as_the_top_level_system_parameter(self):
        """Issue #1687: the Messages API rejects a system role inside messages."""
        params = self._request_params(self._tool_conversation())
        self.assertEqual(params["system"], "be brief")
        self.assertEqual([m["role"] for m in params["messages"]], ["user", "assistant", "user"])

    def test_assistant_tool_calls_become_tool_use_blocks(self):
        params = self._request_params(self._tool_conversation())
        assistant = params["messages"][1]
        self.assertEqual(assistant["content"][0], {"type": "text", "text": "checking"})
        self.assertEqual(
            assistant["content"][1],
            {"type": "tool_use", "id": "call_1", "name": "weather", "input": {"city": "Rio"}},
        )

    def test_tool_message_becomes_a_tool_result_block_in_a_user_message(self):
        params = self._request_params(self._tool_conversation())
        self.assertEqual(
            params["messages"][2],
            {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "call_1", "content": "sunny"}],
            },
        )

    def test_consecutive_tool_messages_share_one_user_message(self):
        from llm.core.types import Message, Role

        params = self._request_params(
            self._tool_conversation(
                [
                    Message(role=Role.TOOL, content="sunny", tool_call_id="call_1"),
                    Message(role=Role.TOOL, content="25C", tool_call_id="call_2"),
                ]
            )
        )
        self.assertEqual(len(params["messages"]), 3)
        self.assertEqual(
            [block["id"] for block in params["messages"][1]["content"] if block["type"] == "tool_use"],
            ["call_1", "call_2"],
        )
        self.assertEqual(
            [block["tool_use_id"] for block in params["messages"][2]["content"]],
            ["call_1", "call_2"],
        )

    def test_tool_message_without_tool_call_id_is_rejected_before_the_call(self):
        from llm.core.types import Message, Role

        orphan = self._tool_conversation([Message(role=Role.TOOL, content="sunny", tool_call_id="call_1")])
        orphan.messages[-1] = Message(role=Role.TOOL, content="sunny")
        with self.assertRaises(ValueError) as ctx:
            self.provider.generate(orphan)
        self.assertIn("tool_call_id", str(ctx.exception))
        self.provider.client.messages.create.assert_not_called()

    def test_every_text_block_is_joined_in_order(self):
        """Issue #1687: only the first text block of the response was returned."""
        self.provider.client.messages.create.return_value = self._make_response(
            [self._text_block("first "), self._tool_block(), self._text_block("second")]
        )
        result = self.provider.generate(_simple_input())
        self.assertEqual(result.content, "first second")

    def test_stream_flag_raises_not_implemented(self):
        """Regression test for issue #923: LLMInput.stream=True was silently
        ignored, downgrading callers to a blocking call. Streaming must fail
        loudly instead of pretending to stream."""
        from llm.core.types import LLMInput, Message, Role

        stream_input = LLMInput(
            messages=[Message(role=Role.USER, content="hi")],
            model="claude-sonnet-4-7",
            stream=True,
        )
        with self.assertRaises(NotImplementedError) as ctx:
            self.provider.generate(stream_input)
        self.assertIn("streaming not supported", str(ctx.exception))
        self.provider.client.messages.create.assert_not_called()


if __name__ == "__main__":
    unittest.main()
