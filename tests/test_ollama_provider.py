"""Tests for OllamaProvider request payload handling."""

import json
import unittest
from unittest.mock import patch

from llm.core.types import LLMInput, Message, Role
from llm.providers.ollama import OllamaProvider


class _Response:
    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(
            {
                "message": {"content": "ok"},
                "prompt_eval_count": 1,
                "eval_count": 2,
                "done_reason": "stop",
            }
        ).encode("utf-8")


class TestOllamaProviderPayload(unittest.TestCase):
    def test_none_temperature_omits_options(self) -> None:
        provider = OllamaProvider(
            base_url="http://localhost:11434",
            default_model="llama3",
        )

        with patch("urllib.request.urlopen", return_value=_Response()) as urlopen:
            result = provider.generate(
                LLMInput(
                    messages=[Message(role=Role.USER, content="hi")],
                    model="llama3",
                    temperature=None,
                )
            )

        request = urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertNotIn("options", payload)
        self.assertEqual(result.content, "ok")


if __name__ == "__main__":
    unittest.main()
