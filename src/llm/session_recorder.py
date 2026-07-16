import json
import os
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from llm.core.redact import redact_secrets as _redact_secrets
from llm.paths import egc_observations_path, project_id, project_root
from llm.session_paths import session_root

logger = logging.getLogger("session_recorder")

# observations.jsonl is plaintext on disk (unlike ~/.egc/state, which is
# AES-256-GCM encrypted) because it's a best-effort tee for the
# continuous-learning observer, not the durable memory store. But a tool
# call's raw command/output can legitimately contain a credential a user
# typed for debugging (e.g. `export DEEPSEEK_API_KEY=sk-...`), so redact
# recognizable secret shapes before writing rather than assuming none will
# ever appear. See llm.core.redact for the pattern list (shared with the
# provider error-mapping paths, which face the same class of leak from raw
# SDK exception text).

# Event types worth teeing into the continuous-learning observations log
# (governance vetoes, mutations, tool results, failures, retries, corrections).
_OBSERVABLE_EVENT_TYPES = {
    "veto", "mutation", "post_tool", "tool_result", "tool_use",
    "error", "failure", "retry", "correction", "governance",
}


def _truthy(val: Optional[str], default: bool = False) -> bool:
    if val is None:
        return default
    return str(val).strip().lower() not in ("0", "false", "no", "off", "")


def _observations_enabled() -> bool:
    """Tee to observations.jsonl unless explicitly disabled or in an automated/minimal session."""
    # Honor the same skip guards observe.sh uses (canonical + legacy).
    if (os.environ.get("EGC_HOOK_PROFILE") or os.environ.get("ECC_HOOK_PROFILE", "")).lower() == "minimal":
        return False
    if _truthy(os.environ.get("EGC_SKIP_OBSERVE") or os.environ.get("ECC_SKIP_OBSERVE"), False):
        return False
    # EGC_TEE_OBSERVATIONS=0 to opt out; default ON.
    return _truthy(os.environ.get("EGC_TEE_OBSERVATIONS") or os.environ.get("ECC_TEE_OBSERVATIONS"), True)


class SessionRecorder:
    """
    Registrador de sessoes minimalista e deterministico (JSONL).
    Garante persistencia atomica de eventos de orquestracao.

    Session files land in the unified session store (`~/.gemini/session-data`
    by default; `.sessions/` is kept if a project already uses it; fully
    env-overridable via `EGC_SESSION_ROOT` / `ECC_SESSION_ROOT` /
    `EGC_SESSION_RECORDING_DIR`). "Interesting" events are also teed (best
    effort) into the project's `observations.jsonl` so the continuous-learning
    observer can see runtime governance/failure signals from the Python side,
    not just the Node hook side.
    """

    def __init__(self, session_id: str, base_dir: Optional[str] = None):
        self.session_id = session_id
        # Path resolution is centralized in llm.session_paths (env-overridable,
        # EGC_* canonical / ECC_* legacy fallback, unified default).
        if base_dir is None:
            base_dir = str(session_root())
        self.base_dir = base_dir
        self.log_path = os.path.join(base_dir, f"{session_id}.jsonl")
        os.makedirs(base_dir, exist_ok=True)

    def record(self, event_type: str, data: Dict[str, Any]):
        """Grava um evento atomico no arquivo JSONL (+ tee opcional para observations.jsonl)."""
        event = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type,
            "session_id": self.session_id,
            "data": data,
        }

        try:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(event) + "\n")
                f.flush()  # Garantia de persistencia imediata
                os.fsync(f.fileno())  # Garantia de escrita no disco
        except Exception as e:
            logger.error(f"Falha ao persistir evento {event_type}: {e}")
            # Fail-silent: persistencia falha, mas o runtime continua.

        # Best-effort tee into the continuous-learning observations log.
        self._tee_observation(event_type, event)

    def _tee_observation(self, event_type: str, event: Dict[str, Any]) -> None:
        if event_type not in _OBSERVABLE_EVENT_TYPES:
            return
        if not _observations_enabled():
            return
        try:
            path = egc_observations_path()
            
            # Map Python event types to observe.sh schema
            # tool_use -> tool_start
            # tool_result -> tool_complete
            obs_event = event_type
            if event_type == "tool_use":
                obs_event = "tool_start"
            elif event_type == "tool_result":
                obs_event = "tool_complete"

            data = event.get("data") or {}
            
            obs = {
                "timestamp": event.get("timestamp"),
                "event": obs_event,
                "tool": data.get("tool") or data.get("tool_name") or "unknown",
                "session": self.session_id,
                "project_id": str(project_id()),
                "project_name": str(project_root().name)
            }

            if obs_event == "tool_start":
                obs["input"] = _redact_secrets(json.dumps(data.get("params") or data.get("tool_input") or {})[:5000])
            elif obs_event == "tool_complete":
                obs["output"] = _redact_secrets(str(data.get("result") or data.get("tool_output") or "")[:5000])

            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(obs) + "\n")
        except Exception as e:  # pragma: no cover - never break record()
            logger.debug(f"observations tee skipped ({event_type}): {e}")
