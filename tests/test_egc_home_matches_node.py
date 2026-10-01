"""The Python runtime finds the EGC directory the way the Node runtime's
getEGCDir() does outside a hook (scripts/lib/utils.js): EGC_DIR, the
tool's own environment variable, ~/.egc when it exists, the first tool
directory that exists, then ~/.egc. It used to fix ~/.gemini, which is
Antigravity's directory, so Python sessions, state, cache, logs and learned
skills landed apart from the Node side. Both runtimes run here from the
package, the way `egc prompt` (scripts/gemini.js) starts the Python one, so
Node's install-path step matches neither."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, Optional

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))

from llm import paths  # noqa: E402
from llm import session_paths  # noqa: E402

TOOL_ENV = [
    "GEMINI_PROJECT_DIR", "GEMINI_PLUGIN_ROOT", "CLAUDECODE", "CLAUDE_PROJECT_DIR", "CLAUDE_PLUGIN_ROOT",
    "CODEBUDDY_PROJECT_DIR", "CODEBUDDY_PLUGIN_ROOT", "VSCODE_AGENT", "GITHUB_COPILOT_API_TOKEN",
    "KIRO_HOOK_FILE", "KIRO_FILE_PATH", "TRAE_ENV",
]
OVERRIDES = [
    "EGC_DIR", "EGC_HOME", "ECC_HOME", "EGC_STATE_ROOT", "EGC_STATE_DIR", "ECC_STATE_DIR",
    "EGC_SESSION_ROOT", "ECC_SESSION_ROOT", "EGC_SESSION_RECORDING_DIR", "ECC_SESSION_RECORDING_DIR",
]
NODE = shutil.which("node")


def _env_for(home: Path, extra: Optional[Dict[str, str]]) -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in TOOL_ENV + OVERRIDES}
    env.update(HOME=str(home), USERPROFILE=str(home))
    env.update(extra or {})
    return env


def _node_egc_dir(home: Path, extra: Optional[Dict[str, str]] = None, fn: str = "getEGCDir") -> Path:
    script = "process.stdout.write(require(process.argv[1])[process.argv[2]]())"
    result = subprocess.run(
        [NODE, "-e", script, str(REPO / "scripts" / "lib" / "utils.js"), fn],
        env=_env_for(home, extra), capture_output=True, text=True, check=True,
    )
    return Path(result.stdout).resolve()


def _python_egc_dir(monkeypatch: pytest.MonkeyPatch, home: Path, extra: Optional[Dict[str, str]] = None) -> Path:
    for name in TOOL_ENV + OVERRIDES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    for name, value in (extra or {}).items():
        monkeypatch.setenv(name, value)
    return paths.egc_home()


@pytest.mark.unit
@pytest.mark.parametrize(
    "layout, extra, expected",
    [
        ([], None, ".egc"),
        ([".claude"], None, ".claude"),
        ([".egc", ".claude"], None, ".egc"),
        ([".egc", ".gemini"], {"CLAUDE_PROJECT_DIR": "/work"}, ".claude"),
        ([".egc", ".gemini"], {"CLAUDECODE": "1"}, ".claude"),
        ([".claude"], {"CLAUDECODE": "1", "GEMINI_PROJECT_DIR": "/work"}, ".gemini"),
        ([".gemini", ".claude"], None, ".gemini"),
    ],
)
def test_python_finds_the_egc_directory_the_node_runtime_finds(monkeypatch, tmp_path, layout, extra, expected):
    home = tmp_path / "home"
    for name in layout:
        (home / name).mkdir(parents=True)
    home.mkdir(exist_ok=True)

    found = _python_egc_dir(monkeypatch, home, extra)

    assert found == (home / expected).resolve()
    if NODE:
        assert found == _node_egc_dir(home, extra), "the Python and Node runtimes agree"


@pytest.mark.unit
def test_egc_dir_overrides_both_runtimes(monkeypatch, tmp_path):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    chosen = {"EGC_DIR": str(tmp_path / "chosen")}

    found = _python_egc_dir(monkeypatch, home, chosen)

    assert found == (tmp_path / "chosen").resolve()
    if NODE:
        assert found == _node_egc_dir(home, chosen)


@pytest.mark.unit
def test_recordings_left_under_the_old_default_can_be_migrated(monkeypatch, tmp_path):
    home = tmp_path / "home"
    (home / ".egc").mkdir(parents=True)
    old = home / ".gemini" / "session-data"
    old.mkdir(parents=True)
    (old / "old.jsonl").write_text("{}\n")
    (old / "2026-01-15-abcd1234-session.tmp").write_text("# a Node session file\n")
    _python_egc_dir(monkeypatch, home)
    monkeypatch.chdir(tmp_path)

    assert old.resolve() in [p.resolve() for p in session_paths.legacy_session_dirs()]
    plan = session_paths.migrate_legacy_sessions(dry_run=True)
    assert plan["target"] == str((home / ".egc" / "session-data").resolve())
    assert [Path(p).name for p in plan["would_copy"]] == ["old.jsonl"], "only the Python recordings, never the Node session files"
    assert (old / "old.jsonl").exists(), "the dry run touches nothing"


@pytest.mark.unit
def test_observations_stay_beside_the_continuous_learning_writers(monkeypatch, tmp_path):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)

    assert _python_egc_dir(monkeypatch, home) == (home / ".claude").resolve()
    assert paths.egc_homunculus_dir() == home.resolve() / ".egc-learning", "one store for every tool, where observe.sh and instinct-cli.py write"
    if NODE:
        assert paths.egc_homunculus_dir() == _node_egc_dir(home, fn="getLearningDir"), "the Node hooks resolve the same store"
