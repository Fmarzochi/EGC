#!/usr/bin/env python3
"""EGC session bridge — Node-invoked Python lifecycle hook."""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path


_HERE = Path(__file__).resolve().parent
_SCRIPTS = _HERE.parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))


def _resolve_workspace_root() -> str:
    explicit = os.environ.get("EGC_WORKSPACE_ROOT") or os.environ.get("PROJECT_ROOT")
    if explicit:
        return explicit
    return os.environ.get("EGC_PLUGIN_ROOT") or os.getcwd()


def _emit_via_tracer(workspace_root: str, event_type: str, execution_id: str, payload: dict) -> bool:
    try:
        from runtime.tracer import TRACER  # type: ignore
    except Exception:
        return False
    try:
        TRACER(workspace_root).trace_event(execution_id, event_type, payload)
        return True
    except Exception:
        return False


def _emit_via_fallback(workspace_root: str, event_type: str, execution_id: str, payload: dict) -> None:
    log_dir = Path(workspace_root) / ".sessions"
    log_dir.mkdir(parents=True, exist_ok=True)
    record = {
        "execution_id": execution_id,
        "type": event_type,
        "timestamp": time.time(),
        "data": payload,
    }
    with (log_dir / "execution_log.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: session_bridge.py <event> [session_id]", file=sys.stderr)
        return 2

    event = argv[1]
    session_id = argv[2] if len(argv) > 2 else (
        os.environ.get("EGC_SESSION_ID") or os.environ.get("ECC_SESSION_ID") or str(uuid.uuid4())
    )

    workspace_root = _resolve_workspace_root()
    event_type = f"session.{event}"
    payload = {
        "session_id": session_id,
        "source": "node-hook",
        "pid": os.getpid(),
    }

    if not _emit_via_tracer(workspace_root, event_type, session_id, payload):
        _emit_via_fallback(workspace_root, event_type, session_id, payload)

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as exc:
        print(f"[session_bridge] error: {exc}", file=sys.stderr)
        sys.exit(1)
