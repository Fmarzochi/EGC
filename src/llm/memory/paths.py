"""
Path hygiene for the memory providers: a category, a session id or a title
supplied by a caller names one entry under the provider's root and nothing
else.
"""
import re
from pathlib import Path
from typing import Optional

_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def safe_segment(value: object) -> Optional[str]:
    """One path segment from a category or a session id, or None when the
    value could name anything but a plain entry under the root."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text in {".", ".."} or not _SEGMENT_RE.match(text):
        return None
    return text


def safe_title(value: object) -> Optional[str]:
    """A file stem from a note title: spaces become underscores and anything
    a path or a filesystem could interpret is replaced."""
    if not isinstance(value, str):
        return None
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip().replace(" ", "_")).strip("._-")
    return stem[:120] or None


def resolve_inside(root: Path, *parts: str) -> Optional[Path]:
    """The path root/parts, or None when it would resolve outside the root."""
    base = root.resolve()
    candidate = base.joinpath(*parts).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        return None
    return candidate
