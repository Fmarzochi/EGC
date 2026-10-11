"""Tests for OllamaProvider request payload handling."""

import json
import os
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


class TestOllamaProviderStreamGuard(unittest.TestCase):
    def test_stream_flag_raises_not_implemented(self) -> None:
        provider = OllamaProvider(
            base_url="http://localhost:11434",
            default_model="llama3",
        )
        stream_input = LLMInput(
            messages=[Message(role=Role.USER, content="hi")],
            model="llama3",
            stream=True,
        )
        with patch("urllib.request.urlopen") as urlopen:
            with self.assertRaises(NotImplementedError) as ctx:
                provider.generate(stream_input)
        self.assertIn("streaming not supported", str(ctx.exception))
        urlopen.assert_not_called()



class TestOllamaProviderCatalog(unittest.TestCase):
    """#1700: the default and the model list come from the catalog checked on 2026-10-11."""

    def test_default_model_comes_from_the_catalog_when_no_env_is_set(self) -> None:
        with patch.dict("os.environ", {}, clear=False):
            for name in ("OLLAMA_MODEL", "LLM_MODEL", "EGC_MODEL", "ECC_MODEL"):
                os.environ.pop(name, None)
            provider = OllamaProvider(base_url="http://localhost:11434")
        self.assertEqual(provider.get_default_model(), "qwen3")

    def test_models_list_carries_the_current_and_the_legacy_default(self) -> None:
        provider = OllamaProvider(base_url="http://localhost:11434", default_model="qwen3")
        by_name = {m.name: m for m in provider.list_models()}
        self.assertIn("qwen3", by_name)
        self.assertIn("llama3.2", by_name)
        self.assertTrue(by_name["qwen3"].supports_tools)
        self.assertTrue(by_name["llama3.2"].supports_tools)

    def test_a_tagged_default_the_registry_does_not_list_is_still_in_the_list(self) -> None:
        provider = OllamaProvider(base_url="http://localhost:11434", default_model="qwen3:8b")
        by_name = {m.name: m for m in provider.list_models()}
        self.assertIn("qwen3:8b", by_name)
        self.assertTrue(by_name["qwen3:8b"].supports_tools)
        self.assertEqual(by_name["qwen3:8b"].context_window, 40960)


if __name__ == "__main__":
    unittest.main()
