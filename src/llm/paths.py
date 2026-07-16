"""Centralized, portable path resolution for the EGC Python runtime.

All runtime/state/cache/log/session directories resolve through this module so
that no Python code hardcodes an absolute path or assumes a username. Every
location is environment-overridable; ``EGC_*`` names are canonical and the
legacy ``ECC_*`` names remain valid as a permanent compatibility bridge.

Defaults are intentionally aligned with the Node side (``scripts/lib/utils.js``,
which uses ``~/.gemini`` as the EGC home / state root) so the two runtimes do
not fragment. ``HOME`` / ``USERPROFILE`` are honored before falling back to
``Path.home()``.

This module never hardcodes ``/home/<user>``, ``/Users/<user>`` or similar.
"""

import hashlib
import subprocess
import os
from pathlib import Path
from typing import Optional


def _first_env(*names: str) -> Optional[str]:
    for n in names:
        v = os.environ.get(n)
        if v and v.strip():
            return v.strip()
    return None


def home_dir() -> Path:
    """User home directory (cross-platform, honors HOME / USERPROFILE)."""
    explicit = os.environ.get("HOME") or os.environ.get("USERPROFILE")
    if explicit and explicit.strip():
        return Path(explicit).expanduser().resolve()
    return Path.home()


def project_root() -> Path:
    """The repository / project root.

    Resolution: ``PROJECT_ROOT`` env -> ``EGC_PLUGIN_ROOT`` / ``ECC_PLUGIN_ROOT``
    env (the marketplace install layout) -> current working directory.
    """
    p = _first_env("PROJECT_ROOT", "EGC_PROJECT_ROOT", "EGC_PLUGIN_ROOT", "ECC_PLUGIN_ROOT", "GEMINI_PLUGIN_ROOT")
    if p:
        return Path(p).expanduser().resolve()
    
    # Fallback to git root if available
    try:
        root = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], 
            stderr=subprocess.DEVNULL,
            text=True
        ).strip()
        return Path(root).resolve()
    except (subprocess.CalledProcessError, OSError, FileNotFoundError):
        return Path.cwd().resolve()


def project_id() -> str:
    """Unique project ID based on git remote URL or path hash.
    
    Matches the logic in detect-project.sh for continuous-learning-v2.
    """
    # 1. Try GEMINI_PROJECT_DIR env
    env_root = os.environ.get("GEMINI_PROJECT_DIR")
    root = Path(env_root).resolve() if env_root else project_root()

    # 2. Try git remote
    remote_url = None
    try:
        remote_url = subprocess.check_output(
            ["git", "-C", str(root), "remote", "get-url", "origin"],
            stderr=subprocess.DEVNULL,
            text=True
        ).strip()
    except (subprocess.CalledProcessError, OSError, FileNotFoundError):
        pass

    hash_input = remote_url if remote_url else str(root)
    # Strip credentials if any
    if remote_url and "://" in remote_url and "@" in remote_url:
        import re
        hash_input = re.sub(r"://[^@]+@", "://", remote_url)

    return hashlib.sha256(hash_input.encode("utf-8")).hexdigest()[:12]


def egc_home() -> Path:
    """EGC home / state root. Default: ``~/.gemini`` (matches the Node runtime).

    Override with ``EGC_HOME`` (canonical) or ``ECC_HOME`` (legacy).
    """
    v = _first_env("EGC_HOME", "ECC_HOME", "EGC_STATE_ROOT")
    if v:
        return Path(v).expanduser().resolve()
    return (home_dir() / ".gemini").resolve()


def egc_homunculus_dir() -> Path:
    """Legacy state root used by continuous-learning-v2."""
    return egc_home() / "homunculus"


def egc_project_dir() -> Path:
    """Project-scoped storage directory: ``~/.gemini/homunculus/projects/<id>``."""
    pid = project_id()
    if pid == "global":
        return egc_homunculus_dir()
    return egc_homunculus_dir() / "projects" / pid


def egc_state_dir() -> Path:
    """Mutable runtime state root. Default: ``egc_home()``."""
    v = _first_env("EGC_STATE_DIR", "ECC_STATE_DIR")
    return Path(v).expanduser().resolve() if v else egc_home()


def egc_runtime_dir() -> Path:
    """Ephemeral runtime artifacts (pids, locks, sockets). Default: ``<state>/runtime``."""
    v = _first_env("EGC_RUNTIME_DIR", "ECC_RUNTIME_DIR")
    return Path(v).expanduser().resolve() if v else (egc_state_dir() / "runtime")


def egc_cache_dir() -> Path:
    """Cache directory. Default: ``<state>/cache``."""
    v = _first_env("EGC_CACHE_DIR", "ECC_CACHE_DIR")
    return Path(v).expanduser().resolve() if v else (egc_state_dir() / "cache")


def egc_log_dir() -> Path:
    """Log directory. Default: ``<state>/logs``."""
    v = _first_env("EGC_LOG_DIR", "ECC_LOG_DIR")
    return Path(v).expanduser().resolve() if v else (egc_state_dir() / "logs")


def egc_memory_dir() -> Path:
    """Cognitive-memory / learned-knowledge directory. Default: ``<state>/skills/learned``.

    (Mirrors the Node ``getLearnedSkillsDir()``.)
    """
    v = _first_env("EGC_MEMORY_DIR", "ECC_MEMORY_DIR")
    return Path(v).expanduser().resolve() if v else (egc_state_dir() / "skills" / "learned")


def egc_session_dir() -> Path:
    """Session-transcript recording directory.

    Resolution: ``EGC_SESSION_RECORDING_DIR`` / ``ECC_SESSION_RECORDING_DIR``
    (the existing/legacy variable used by ``SessionRecorder``) -> ``EGC_SESSION_DIR``
    -> ``.sessions`` (project-local default, preserved for backward compatibility).
    """
    v = _first_env("EGC_SESSION_RECORDING_DIR", "ECC_SESSION_RECORDING_DIR", "EGC_SESSION_DIR", "ECC_SESSION_DIR")
    if v:
        return Path(v).expanduser().resolve()
    return Path(".sessions")


def egc_canonical_sessions_dir() -> Path:
    """Canonical home-rooted session store: ``<state>/session-data`` (matches Node)."""
    return egc_state_dir() / "session-data"


def egc_legacy_sessions_dir() -> Path:
    """Legacy home-rooted session store: ``<state>/sessions`` (matches Node)."""
    return egc_state_dir() / "sessions"


def egc_observations_path() -> Path:
    """Observations log consumed by the continuous-learning pipeline.

    Default: ``~/.gemini/homunculus/projects/<id>/observations.jsonl`` - matches
    the location used by ``observe.sh`` and ``observer-loop.sh``. 
    Override with ``EGC_OBSERVATIONS_PATH`` / ``ECC_OBSERVATIONS_PATH``.
    """
    v = _first_env("EGC_OBSERVATIONS_PATH", "ECC_OBSERVATIONS_PATH")
    if v:
        return Path(v).expanduser().resolve()
    
    pdir = egc_project_dir()
    pdir.mkdir(parents=True, exist_ok=True)
    return pdir / "observations.jsonl"


def ensure_dir(path) -> Path:
    """Create ``path`` (and parents) if missing; return it as a ``Path``."""
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


__all__ = [
    "home_dir", "project_root", "egc_home", "egc_state_dir", "egc_runtime_dir",
    "egc_cache_dir", "egc_log_dir", "egc_memory_dir", "egc_session_dir",
    "egc_canonical_sessions_dir", "egc_legacy_sessions_dir", "egc_observations_path",
    "ensure_dir",
]
