"""Retries for the provider calls whose client does not retry on its own.

The OpenAI, Anthropic and Cohere SDKs already retry a rate limit, a server
error or a dropped connection with backoff; the Gemini client and the plain
HTTP call to Ollama do not. Those calls go through ``call_with_retries``,
which retries only what a later attempt can fix, a bounded number of times.
"""

from __future__ import annotations

import socket
import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")

MAX_ATTEMPTS = 3
BASE_DELAY_S = 0.5
MAX_DELAY_S = 8.0

# Text an error from a client without a status attribute carries when a
# later attempt can succeed.
_TRANSIENT_MARKERS = ("429", "rate limit", "resource_exhausted", "unavailable", "overloaded", "503", "502", "504")


def _status_of(error: BaseException) -> int | None:
    for attribute in ("status_code", "code", "status"):
        value = getattr(error, attribute, None)
        if isinstance(value, int):
            return value
    return None


def is_transient(error: BaseException) -> bool:
    """Whether a later attempt of the same call can succeed."""
    status = _status_of(error)
    if status is not None:
        return status == 429 or status >= 500
    if isinstance(error, (TimeoutError, socket.timeout, ConnectionResetError, ConnectionAbortedError)):
        return True
    reason = getattr(error, "reason", None)
    if isinstance(reason, BaseException) and reason is not error:
        return is_transient(reason)
    text = str(error).lower()
    return any(marker in text for marker in _TRANSIENT_MARKERS)


def retry_delay(error: BaseException, attempt: int) -> float:
    """Seconds to wait before attempt ``attempt + 1``: the server's
    Retry-After when it gives one, an exponential backoff otherwise."""
    headers = getattr(error, "headers", None)
    retry_after = _seconds(headers.get("Retry-After")) if hasattr(headers, "get") else None
    if retry_after is not None:
        return min(MAX_DELAY_S, max(0.0, retry_after))
    return min(MAX_DELAY_S, BASE_DELAY_S * (2 ** (attempt - 1)))


def _seconds(value: object) -> float | None:
    """A Retry-After given in seconds; None for a date or anything else."""
    text = str(value).strip() if value is not None else ""
    return float(text) if text.replace(".", "", 1).isdigit() else None


def call_with_retries(
    call: Callable[[], T],
    *,
    attempts: int = MAX_ATTEMPTS,
    sleep: Callable[[float], None] | None = None,
) -> T:
    """``call()``, attempted again after a transient error, at most
    ``attempts`` times; any other error, or the last one, is raised.
    ``sleep`` defaults to ``time.sleep``, looked up when it is needed."""
    for attempt in range(1, attempts + 1):
        try:
            return call()
        except Exception as error:
            if attempt == attempts or not is_transient(error):
                raise
            (sleep or time.sleep)(retry_delay(error, attempt))
    raise RuntimeError("call_with_retries needs at least one attempt")
