"""Tests for llm.core.redact — shared by session_recorder.py and the
provider error-mapping paths. See test_session_recorder.py for the
observations.jsonl-specific coverage."""
from __future__ import annotations

import pytest

from llm.core.redact import redact_secrets


@pytest.mark.unit
def test_redacts_env_style_assignment() -> None:
    result = redact_secrets("GROQ_API_KEY=gsk_abcdefghijklmnopqrstuvwx")
    assert "gsk_abcdefghijklmnopqrstuvwx" not in result
    assert "GROQ_API_KEY" in result


@pytest.mark.unit
def test_redacts_bearer_header() -> None:
    result = redact_secrets("Authorization: Bearer sk-live-abcdefghijklmno")
    assert "sk-live-abcdefghijklmno" not in result


@pytest.mark.unit
def test_leaves_plain_text_unchanged() -> None:
    text = "rate limit exceeded, retry after 30s"
    assert redact_secrets(text) == text


@pytest.mark.unit
def test_none_and_empty_pass_through() -> None:
    assert redact_secrets(None) is None
    assert redact_secrets("") == ""
