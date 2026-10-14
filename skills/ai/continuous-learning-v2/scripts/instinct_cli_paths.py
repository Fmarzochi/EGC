"""Configuration and path constants for the Instinct CLI.

These are read as plain module globals by instinct-cli.py (and re-exported
there under the same names), which is what the test suite monkeypatches to
redirect every path into a throwaway directory. Keep that in mind before
moving code that reads these constants into another module: a sibling's own
`from instinct_cli_paths import X` binds its own independent copy of the
value and will not observe a patch applied to instinct-cli.py's copy.
"""

import os
from pathlib import Path


def _home_dir() -> Path:
    """The home the Node hooks and src/llm/paths.py use: HOME, then USERPROFILE."""
    explicit = os.environ.get("HOME") or os.environ.get("USERPROFILE")
    if explicit and explicit.strip():
        return Path(explicit).expanduser().resolve()
    return Path.home()


HOMUNCULUS_DIR = _home_dir() / ".egc-learning"
PROJECTS_DIR = HOMUNCULUS_DIR / "projects"
REGISTRY_FILE = HOMUNCULUS_DIR / "projects.json"

# Global (non-project-scoped) paths
GLOBAL_INSTINCTS_DIR = HOMUNCULUS_DIR / "instincts"
GLOBAL_PERSONAL_DIR = GLOBAL_INSTINCTS_DIR / "personal"
GLOBAL_INHERITED_DIR = GLOBAL_INSTINCTS_DIR / "inherited"
GLOBAL_EVOLVED_DIR = HOMUNCULUS_DIR / "evolved"
GLOBAL_OBSERVATIONS_FILE = HOMUNCULUS_DIR / "observations.jsonl"

# Thresholds for auto-promotion
PROMOTE_CONFIDENCE_THRESHOLD = 0.8
PROMOTE_MIN_PROJECTS = 2
ALLOWED_INSTINCT_EXTENSIONS = (".yaml", ".yml", ".md")

# Default TTL for pending instincts (days)
PENDING_TTL_DAYS = 30
# Warning threshold: show expiry warning when instinct expires within this many days
PENDING_EXPIRY_WARNING_DAYS = 7


def _ensure_global_dirs() -> None:
    """Ensure global directories exist (deferred to avoid side effects at import time)."""
    for d in [GLOBAL_PERSONAL_DIR, GLOBAL_INHERITED_DIR,
              GLOBAL_EVOLVED_DIR / "skills", GLOBAL_EVOLVED_DIR / "commands", GLOBAL_EVOLVED_DIR / "agents",
              PROJECTS_DIR]:
        d.mkdir(parents=True, exist_ok=True)
