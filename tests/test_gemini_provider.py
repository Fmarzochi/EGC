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
