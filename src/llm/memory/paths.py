"""
Path hygiene for the memory providers: a category, a session id or a title
supplied by a caller names one entry under the provider's root and nothing
else.
"""
import os
import re
import stat
import tempfile
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
    """A file stem from a note title: spaces become underscores, letters and
    digits of any script stay, and anything a path or a filesystem could
    interpret is replaced."""
    if not isinstance(value, str):
        return None
    stem = re.sub(r"[^\w.-]+", "_", value.strip().replace(" ", "_")).strip("._-")
    # Filesystems bound names in bytes: cut on a character boundary.
    return stem.encode("utf-8")[:120].decode("utf-8", "ignore") or None



def _private_mode(target: Path) -> Optional[int]:
    """The permission bits of an existing regular `target`, else None."""
    try:
        status = os.lstat(target)
    except OSError:
        return None
    return stat.S_IMODE(status.st_mode) if stat.S_ISREG(status.st_mode) else None


def write_text_atomic(target: Path, text: str) -> None:
    """Replace `target` with `text` through a unique temporary sibling and a
    rename, so a link (hard or symbolic) planted at the target is replaced,
    never written through; the existing file's mode is kept and the
    temporary never survives a failure."""
    mode = _private_mode(target)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
        if mode is not None:
            os.chmod(temporary, mode)
        os.replace(temporary, target)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _is_private_regular(status: os.stat_result) -> bool:
    """A regular file with a single name: not a link of any kind."""
    return stat.S_ISREG(status.st_mode) and status.st_nlink == 1


def read_text_if_regular(target: Path) -> str:
    """The text of `target` when it is a regular file with a single name
    (neither a symbolic nor a hard link), else ''."""
    try:
        status = os.lstat(target)
    except OSError:
        return ""
    if not _is_private_regular(status):
        return ""
    with open(target, "r", encoding="utf-8") as handle:
        return handle.read()


def append_text_private(target: Path, text: str) -> bool:
    """Append `text` to `target` in one write, creating it when missing, and
    never through a link: the file is opened without following symbolic
    links and refused when it has more than one name. Concurrent appends
    keep each other's lines."""
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(target, flags, 0o600)
    except OSError:
        return False
    try:
        if not _is_private_regular(os.fstat(descriptor)):
            return False
        os.write(descriptor, text.encode("utf-8"))
        return True
    finally:
        os.close(descriptor)




def resolve_inside(root: Path, *parts: str) -> Optional[Path]:
    """The path root/parts, or None when it would resolve outside the root."""
    base = root.resolve()
    candidate = base.joinpath(*parts).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        return None
    return candidate
