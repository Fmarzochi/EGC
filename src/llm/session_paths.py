"""Unified session-storage path resolution + a safe legacy migrator.

Goal: the Python runtime records sessions into the *same logical store* the
Node runtime uses (``~/.gemini/session-data``) instead of a separate
project-local ``.sessions/`` directory, WITHOUT breaking projects that are
already recording into ``.sessions/`` and WITHOUT touching old session files.

Resolution order for the active session root:

  1. ``EGC_SESSION_ROOT`` env (canonical) / ``ECC_SESSION_ROOT`` (legacy bridge)
  2. ``EGC_SESSION_RECORDING_DIR`` / ``ECC_SESSION_RECORDING_DIR`` (the
     pre-existing variable used by SessionRecorder - kept for backward compat)
  3. ``./.sessions/`` IF it already exists in the current project (so a project
     that has been recording there keeps doing so - no break)
  4. ``<EGC state root>/session-data`` i.e. ``~/.gemini/session-data`` (the
     unified default, matching the Node side's ``getSessionsDir()``)

Migration (``migrate_legacy_sessions``) is dry-run by default, idempotent, and
never overwrites an existing destination file.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Dict, List

from llm.paths import _first_env, egc_canonical_sessions_dir, egc_legacy_sessions_dir, project_root


_LOCAL_SESSIONS_DIRNAME = ".sessions"


def session_root() -> Path:
    """The active session-recording directory (see module docstring for order)."""
    explicit = _first_env("EGC_SESSION_ROOT", "ECC_SESSION_ROOT",
                          "EGC_SESSION_RECORDING_DIR", "ECC_SESSION_RECORDING_DIR")
    if explicit:
        return Path(explicit).expanduser().resolve()
    local = project_root() / _LOCAL_SESSIONS_DIRNAME
    if local.is_dir():
        return local
    return egc_canonical_sessions_dir()


def legacy_session_dirs() -> List[Path]:
    """Directories that may hold sessions from older layouts (read-only sources for migration)."""
    out: List[Path] = []
    for p in (project_root() / _LOCAL_SESSIONS_DIRNAME, egc_legacy_sessions_dir()):
        if p.is_dir() and p.resolve() != session_root().resolve():
            out.append(p)
    return out


def migrate_legacy_sessions(dry_run: bool = True) -> Dict[str, object]:
    """Copy session JSONL files from legacy locations into the unified store.

    Idempotent: never overwrites an existing destination file. Returns a plan
    dict: ``{"target": <path>, "dry_run": bool, "would_copy": [...], "copied": [...],
    "skipped_existing": [...], "sources": [...]}``. With ``dry_run=True`` (default)
    nothing is written.
    """
    target = session_root()
    plan: Dict[str, object] = {
        "target": str(target),
        "dry_run": dry_run,
        "sources": [],
        "would_copy": [],
        "copied": [],
        "skipped_existing": [],
        "errors": [],
    }
    sources = legacy_session_dirs()
    plan["sources"] = [str(s) for s in sources]
    if not sources:
        return plan
    if not dry_run:
        target.mkdir(parents=True, exist_ok=True)
    for src in sources:
        for f in sorted(src.glob("*.jsonl")):
            _copy_session_file(f, target / f.name, plan, dry_run, str(f))
    return plan


def _copy_session_file(f: Path, dst: Path, plan: Dict, dry_run: bool, rel: str) -> None:
    if dst.exists():
        plan["skipped_existing"].append(rel)  # type: ignore[union-attr]
        return
    if dry_run:
        plan["would_copy"].append(rel)  # type: ignore[union-attr]
        return
    try:
        shutil.copy2(f, dst)
        plan["copied"].append(rel)  # type: ignore[union-attr]
    except Exception as e:  # pragma: no cover - defensive
        plan["errors"].append(f"{rel}: {e}")  # type: ignore[union-attr]


__all__ = ["session_root", "legacy_session_dirs", "migrate_legacy_sessions"]


if __name__ == "__main__":  # pragma: no cover - simple CLI
    import json
    import sys
    apply = "--apply" in sys.argv
    print(json.dumps(migrate_legacy_sessions(dry_run=not apply), indent=2))
