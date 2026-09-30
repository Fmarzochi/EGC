"""The instinct tee of scripts/memory/persistent_memory.py writes into the
CLI state store, whose one home is <EGC dir>/egc/state.db: ~/.egc by
default and EGC_DIR when set (scripts/lib/state-store/path.js). The
retired Gemini CLI's ~/.gemini/egc/state.db is not a store any tool reads."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from memory.persistent_memory import _resolve_state_db_path  # noqa: E402


@pytest.mark.unit
def test_state_db_lives_under_the_shared_egc_directory(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("EGC_DIR", raising=False)

    assert _resolve_state_db_path() == str(tmp_path / ".egc" / "egc" / "state.db")


@pytest.mark.unit
def test_egc_dir_overrides_the_state_db_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("EGC_DIR", str(tmp_path / "elsewhere"))

    assert _resolve_state_db_path() == str(tmp_path / "elsewhere" / "egc" / "state.db")
