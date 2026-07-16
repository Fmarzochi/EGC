"""Tests for llm.session_recorder — secret redaction in observations.jsonl.

Regression coverage for audit EGC-128 (medium): observations.jsonl is
plaintext by design (best-effort tee, not the durable encrypted state
store), but tool input/output could legitimately contain a credential a
user typed for debugging. Previously written verbatim with no redaction.
"""
from __future__ import annotations

import json

import pytest

from llm.session_recorder import SessionRecorder, _redact_secrets


@pytest.mark.unit
class TestRedactSecrets:
    def test_redacts_env_style_api_key_assignment(self) -> None:
        text = "export DEEPSEEK_API_KEY=sk-abcdef1234567890abcdef"
        result = _redact_secrets(text)
        assert "sk-abcdef1234567890abcdef" not in result
        assert "<REDACTED>" in result
        assert "DEEPSEEK_API_KEY" in result  # keep the variable name, drop the value

    def test_redacts_authorization_bearer_header(self) -> None:
        text = 'curl -H "Authorization: Bearer sk-live-abcdefghijklmnop" https://api.example.com'
        result = _redact_secrets(text)
        assert "sk-live-abcdefghijklmnop" not in result
        assert "Authorization: Bearer <REDACTED>" in result

    def test_redacts_bare_provider_key_prefixes(self) -> None:
        assert "<REDACTED>" in _redact_secrets("token is sk-proj-abcdefghij1234567890")
        assert "<REDACTED>" in _redact_secrets("leaked ghp_abcdefghijklmnopqrstuvwxyz012345")
        assert "<REDACTED>" in _redact_secrets("AWS key AKIAABCDEFGHIJKLMNOP in the env")
        assert "<REDACTED>" in _redact_secrets("slack token xoxb-1234567890-abcdefghij")

    def test_leaves_ordinary_text_unchanged(self) -> None:
        text = "npm install left-pad && git status"
        assert _redact_secrets(text) == text

    def test_handles_empty_and_none_gracefully(self) -> None:
        assert _redact_secrets("") == ""
        assert _redact_secrets(None) is None


@pytest.mark.unit
def test_tee_observation_redacts_secret_in_tool_input(tmp_path, monkeypatch) -> None:
    obs_path = tmp_path / "observations.jsonl"
    monkeypatch.setenv("EGC_OBSERVATIONS_PATH", str(obs_path))
    monkeypatch.setenv("EGC_TEE_OBSERVATIONS", "1")
    monkeypatch.delenv("EGC_SKIP_OBSERVE", raising=False)
    monkeypatch.delenv("EGC_HOOK_PROFILE", raising=False)

    recorder = SessionRecorder(session_id="test-session", base_dir=str(tmp_path))
    recorder.record("tool_use", {
        "tool": "Bash",
        "tool_input": {"command": "export MISTRAL_API_KEY=sk-super-secret-value-1234"},
    })

    lines = obs_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    obs = json.loads(lines[0])
    assert "sk-super-secret-value-1234" not in obs["input"]
    assert "<REDACTED>" in obs["input"]
