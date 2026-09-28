"""The provider calls whose client does not retry on its own (Gemini, Ollama)
are retried after an error a later attempt can fix, a bounded number of
times, and not after any other error."""

import json
import socket
import urllib.error
from unittest.mock import MagicMock, patch

import pytest

from llm.core import retry
from llm.core.types import LLMInput, Message, Role


class _StatusError(Exception):
    def __init__(self, code, headers=None):
        super().__init__(f"status {code}")
        self.code = code
        self.headers = headers or {}


@pytest.mark.unit
@pytest.mark.parametrize(
    "error, transient",
    [
        (_StatusError(429), True),
        (_StatusError(500), True),
        (_StatusError(503), True),
        (_StatusError(401), False),
        (_StatusError(404), False),
        (TimeoutError("timed out"), True),
        (socket.timeout("timed out"), True),
        (ConnectionResetError("reset"), True),
        (urllib.error.URLError(ConnectionResetError("reset")), True),
        (urllib.error.URLError(ConnectionRefusedError("refused")), False),
        (Exception("503 UNAVAILABLE: the model is overloaded"), True),
        (Exception("RESOURCE_EXHAUSTED"), True),
        (Exception("invalid argument"), False),
        (Exception("HTTP 400: the word 'rate limit' or 503 is not a status"), False),
    ],
)
def test_is_transient(error, transient):
    assert retry.is_transient(error) is transient


@pytest.mark.unit
def test_the_gemini_sdk_errors_are_read_by_their_code():
    errors = pytest.importorskip("google.genai.errors")
    assert retry.is_transient(errors.ClientError(429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED"}}))
    assert retry.is_transient(errors.ServerError(503, {"error": {"code": 503, "status": "UNAVAILABLE"}}))
    assert not retry.is_transient(errors.ClientError(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT"}}))
    assert not retry.is_transient(errors.ClientError(403, {"error": {"code": 403, "status": "PERMISSION_DENIED"}}))


@pytest.mark.unit
def test_delay_backs_off_and_honours_retry_after():
    assert retry.retry_delay(_StatusError(503), 1) == 0.5
    assert retry.retry_delay(_StatusError(503), 2) == 1.0
    assert retry.retry_delay(_StatusError(503), 10) == retry.MAX_DELAY_S
    assert retry.retry_delay(_StatusError(429, {"Retry-After": "2"}), 1) == 2.0
    assert retry.retry_delay(_StatusError(429, {"Retry-After": "600"}), 1) == retry.MAX_DELAY_S
    assert retry.retry_delay(_StatusError(429, {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}), 1) == 0.5


@pytest.mark.unit
def test_retries_a_transient_error_then_returns():
    calls, sleeps = [], []

    def call():
        calls.append(1)
        if len(calls) < 3:
            raise _StatusError(503)
        return "ok"

    assert retry.call_with_retries(call, sleep=sleeps.append) == "ok"
    assert len(calls) == 3
    assert sleeps == [0.5, 1.0]


@pytest.mark.unit
def test_gives_up_after_the_last_attempt_and_raises_it():
    calls = []

    def call():
        calls.append(1)
        raise _StatusError(429)

    with pytest.raises(_StatusError):
        retry.call_with_retries(call, sleep=lambda _: None)
    assert len(calls) == retry.MAX_ATTEMPTS


@pytest.mark.unit
def test_does_not_retry_an_error_a_later_attempt_cannot_fix():
    calls = []

    def call():
        calls.append(1)
        raise _StatusError(401)

    with pytest.raises(_StatusError):
        retry.call_with_retries(call, sleep=lambda _: None)
    assert len(calls) == 1


class _Response:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def read(self):
        return json.dumps({"message": {"content": "ok"}, "prompt_eval_count": 1, "eval_count": 1}).encode("utf-8")


@pytest.mark.unit
def test_ollama_retries_a_server_error_before_answering():
    from llm.providers.ollama import OllamaProvider

    provider = OllamaProvider(base_url="http://localhost:11434", default_model="llama3")
    busy = urllib.error.HTTPError("http://localhost:11434/api/chat", 503, "busy", {}, None)
    with patch("urllib.request.urlopen", side_effect=[busy, _Response()]) as urlopen, patch.object(retry.time, "sleep") as sleep, \
            patch.object(busy, "close", wraps=busy.close) as closed:
        result = provider.generate(LLMInput(messages=[Message(role=Role.USER, content="hi")], model="llama3"))
    assert result.content == "ok"
    assert urlopen.call_count == 2
    sleep.assert_called_once_with(0.5)
    closed.assert_called_once_with()


@pytest.mark.unit
def test_gemini_retries_a_rate_limit_before_answering():
    with patch("llm.providers.gemini.genai") as genai:
        from llm.providers.gemini import GeminiProvider

        provider = GeminiProvider(api_key="test-key")
        client = genai.Client.return_value
        answer = MagicMock()
        client.models.generate_content.side_effect = [_StatusError(429), answer]
        with patch.object(retry.time, "sleep"):
            response, model = provider._call_api_with_fallback("gemini-2.5-flash", [], {}, None)
    assert response is answer
    assert model == "gemini-2.5-flash"
    assert client.models.generate_content.call_count == 2
