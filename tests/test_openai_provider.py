"""Tests for OpenAIProvider response handling."""

import unittest
from unittest.mock import MagicMock

from llm.core.interface import LLMError
from llm.core.types import LLMInput, Message, ProviderType, Role
from llm.providers.openai import OpenAIProvider


def _simple_input():
    return LLMInput(
        messages=[Message(role=Role.USER, content="hi")],
        model="gpt-4o-mini",
    )


class TestOpenAIProviderResponseHandling(unittest.TestCase):
    def setUp(self):
        self.provider = OpenAIProvider.__new__(OpenAIProvider)
        self.provider.client = MagicMock()
        self.provider._models = []

    def test_empty_choices_raise_llm_error(self):
        response = MagicMock()
        response.choices = []
        self.provider.client.chat.completions.create.return_value = response

        with self.assertRaises(LLMError) as exc:
            self.provider.generate(_simple_input())

        self.assertEqual(exc.exception.provider, ProviderType.OPENAI)
        self.assertIn("empty choices", str(exc.exception))


if __name__ == "__main__":
    unittest.main()
