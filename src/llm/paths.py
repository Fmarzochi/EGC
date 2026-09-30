"""Centralized, portable path resolution for the EGC Python runtime.

All runtime/state/cache/log/session directories resolve through this module so
that no Python code hardcodes an absolute path or assumes a username. Every
location is environment-overridable; ``EGC_*`` names are canonical and the
legacy ``ECC_*`` names remain valid as a permanent compatibility bridge.

Defaults are intentionally aligned with the Node side (``getEGCDir()`` in
``scripts/lib/utils.js``: the EGC directory of the tool in use) so the two
runtimes do not fragment. ``HOME`` / ``USERPROFILE`` are honored before falling
back to ``Path.home()``.

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
    except (subprocess.CalledProcessError, OSError):
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
    except (subprocess.CalledProcessError, OSError):
        pass

    hash_input = remote_url if remote_url else str(root)
    # Strip credentials if any
    if remote_url and "://" in remote_url and "@" in remote_url:
        import re
        hash_input = re.sub(r"://[^@]+@", "://", remote_url)

    return hashlib.sha256(hash_input.encode("utf-8")).hexdigest()[:12]


# The tool directories getEGCDir() knows, in its order (longest prefix first).
_TOOL_DIRS = (
    (".codeium", "windsurf"), (".config", "opencode"), (".config", "zed"),
    (".gemini",), (".claude",), (".cursor",), (".agents",), (".amp",),
    (".continue",), (".github",), (".kiro",), (".trae",), (".trae-cn",), (".codebuddy",),
)

# The variables each tool sets for its hooks, in getEGCDir()'s order: the
# Gemini ones first, because the retired Gemini CLI also set the Claude ones.
_TOOL_ENV = (
    (("GEMINI_PROJECT_DIR", "GEMINI_PLUGIN_ROOT"), ".gemini"),
    (("CLAUDE_PROJECT_DIR", "CLAUDE_PLUGIN_ROOT"), ".claude"),
    (("CODEBUDDY_PROJECT_DIR", "CODEBUDDY_PLUGIN_ROOT"), ".codebuddy"),
    (("VSCODE_AGENT", "GITHUB_COPILOT_API_TOKEN"), ".github"),
    (("KIRO_HOOK_FILE", "KIRO_FILE_PATH"), ".kiro"),
)


def _tool_dir_from_env(home: Path) -> Optional[Path]:
    for names, dirname in _TOOL_ENV:
        if any(os.environ.get(n) for n in names):
            return home / dirname
    trae = os.environ.get("TRAE_ENV")
    if trae:
        return home / (".trae-cn" if trae == "cn" else ".trae")
    return None


def egc_home() -> Path:
    """EGC home / state root: the directory ``getEGCDir()`` gives the Node runtime.

    Resolution: ``EGC_HOME`` / ``ECC_HOME`` / ``EGC_STATE_ROOT`` (Python only),
    ``EGC_DIR`` (shared with Node), the directory of the tool whose hook
    variables are set, ``~/.egc`` when it exists, the first tool directory that
    exists, else ``~/.egc``. Node's install-path step does not apply: the Python
    runtime runs from the package, never from a tool's directory.
    """
    v = _first_env("EGC_HOME", "ECC_HOME", "EGC_STATE_ROOT", "EGC_DIR")
    if v:
        return Path(v).expanduser().resolve()
    home = home_dir()
    from_env = _tool_dir_from_env(home)
    if from_env is not None:
        return from_env.resolve()
    egc = home / ".egc"
    if egc.exists():
        return egc.resolve()
    for parts in _TOOL_DIRS:
        candidate = home.joinpath(*parts)
        if candidate.exists():
            return candidate.resolve()
    return egc.resolve()


def egc_homunculus_dir() -> Path:
    """State root of continuous-learning-v2: ``~/.gemini/homunculus``.

    observe.sh, start-observer.sh, detect-project.sh and instinct-cli.py write
    observations and instincts there whatever the tool, so the recorder keeps
    writing beside them until that store moves with all of its writers.
    """
    return home_dir() / ".gemini" / "homunculus"


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
