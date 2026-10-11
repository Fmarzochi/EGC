"""Tests for GeminiProvider message handling."""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from llm.core.types import LLMInput, Message, Role
from llm.providers import gemini as gemini_module
from llm.providers.gemini import GeminiProvider


class _PartStub:
    @staticmethod
    def from_text(text: str | None) -> SimpleNamespace:
        if text is None:
            raise TypeError("argument of type 'NoneType' is not iterable")
        return SimpleNamespace(text=text, function_call=None)

    @staticmethod
    def from_function_call(name: str, args: dict) -> SimpleNamespace:
        return SimpleNamespace(text=None, function_call=SimpleNamespace(name=name, args=args))

    @staticmethod
    def from_function_response(name: str, response: dict) -> SimpleNamespace:
        return SimpleNamespace(text=None, function_call=None, function_response=SimpleNamespace(name=name, response=response))


class _TypesStub:
    Part = _PartStub
    Content = SimpleNamespace
    GenerateContentConfig = SimpleNamespace


def _gemini_response() -> SimpleNamespace:
    part = SimpleNamespace(text="ok", function_call=None)
    content = SimpleNamespace(parts=[part])
    candidate = SimpleNamespace(content=content, finish_reason="STOP")
    return SimpleNamespace(
        candidates=[candidate],
        usage_metadata=None,
    )


class TestGeminiProviderMessageHandling(unittest.TestCase):
    def setUp(self) -> None:
        self._patch = patch.object(gemini_module, "types", _TypesStub)
        self._patch.start()
        self.provider = GeminiProvider.__new__(GeminiProvider)
        self.provider.client = MagicMock()
        self.provider.client.models.generate_content.return_value = _gemini_response()
        self.provider._fallback_chain = {}
        self.provider._models = []

    def tearDown(self) -> None:
        self._patch.stop()

    def test_none_content_is_sent_as_empty_text(self) -> None:
        result = self.provider.generate(
            LLMInput(
                messages=[Message(role=Role.ASSISTANT, content=None)],
                model="gemini-2.5-pro",
                temperature=None,
            )
        )

        call_kwargs = self.provider.client.models.generate_content.call_args.kwargs
        self.assertEqual(call_kwargs["contents"][0].parts[0].text, "")
        self.assertEqual(result.content, "ok")

    def _request_kwargs(self, messages: list[Message]) -> dict:
        self.provider.generate(LLMInput(messages=messages, model="gemini-2.5-pro", temperature=None))
        return self.provider.client.models.generate_content.call_args.kwargs

    def test_every_system_message_joins_the_system_instruction_in_order(self) -> None:
        """Issue #1690: each system message overwrote system_instruction."""
        call_kwargs = self._request_kwargs(
            [
                Message(role=Role.SYSTEM, content="You are terse."),
                Message(role=Role.USER, content="hi"),
                Message(role=Role.SYSTEM, content="Answer in English."),
            ]
        )
        self.assertEqual(call_kwargs["config"].system_instruction, "You are terse.\n\nAnswer in English.")
        self.assertEqual([c.role for c in call_kwargs["contents"]], ["user"])

    def test_consecutive_messages_of_one_side_merge_into_one_content(self) -> None:
        """Issue #1690: two user or two assistant messages in a row broke the user/model alternation."""
        call_kwargs = self._request_kwargs(
            [
                Message(role=Role.USER, content="first"),
                Message(role=Role.USER, content="second"),
                Message(role=Role.ASSISTANT, content="third"),
                Message(role=Role.ASSISTANT, content="fourth"),
                Message(role=Role.USER, content="fifth"),
            ]
        )
        contents = call_kwargs["contents"]
        self.assertEqual([c.role for c in contents], ["user", "model", "user"])
        self.assertEqual([p.text for p in contents[0].parts], ["first", "second"])
        self.assertEqual([p.text for p in contents[1].parts], ["third", "fourth"])
        self.assertEqual([p.text for p in contents[2].parts], ["fifth"])

    def test_tool_result_and_next_user_message_share_one_user_turn(self) -> None:
        from llm.core.types import ToolCall

        # A tool result also feeds the PostToolUse dispatcher, which runs the
        # configured hooks; the unit test keeps that out with a mock.
        with patch.object(self.provider, "_dispatch_post_tool_results") as dispatch:
            call_kwargs = self._request_kwargs(
                [
                    Message(role=Role.USER, content="weather?"),
                    Message(
                        role=Role.ASSISTANT,
                        content="",
                        tool_calls=[ToolCall(id="call_1", name="weather", arguments={"city": "Rio"})],
                    ),
                    Message(role=Role.TOOL, content='{"sky": "sunny"}', name="weather", tool_call_id="call_1"),
                    Message(role=Role.USER, content="and tomorrow?"),
                ]
            )
        dispatch.assert_called_once()
        contents = call_kwargs["contents"]
        self.assertEqual([c.role for c in contents], ["user", "model", "user"])
        self.assertEqual(contents[1].parts[0].function_call.name, "weather")
        self.assertEqual(contents[2].parts[0].function_response.response, {"sky": "sunny"})
        self.assertEqual(contents[2].parts[1].text, "and tomorrow?")


class TestGeminiProviderStreamGuard(unittest.TestCase):
    def setUp(self) -> None:
        self._patch = patch.object(gemini_module, "types", _TypesStub)
        self._patch.start()
        self.provider = GeminiProvider.__new__(GeminiProvider)
        self.provider.client = MagicMock()
        self.provider.client.models.generate_content.return_value = _gemini_response()
        self.provider._fallback_chain = {}
        self.provider._models = []

    def tearDown(self) -> None:
        self._patch.stop()

    def test_stream_flag_raises_not_implemented(self) -> None:
        stream_input = LLMInput(
            messages=[Message(role=Role.USER, content="hi")],
            model="gemini-2.5-pro",
            stream=True,
        )
        with self.assertRaises(NotImplementedError) as ctx:
            self.provider.generate(stream_input)
        self.assertIn("streaming not supported", str(ctx.exception))
        self.provider.client.models.generate_content.assert_not_called()


if __name__ == "__main__":
    unittest.main()
