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


def _open_private(target: Path, flags: int) -> Optional[int]:
    """A descriptor on `target` when it is a regular file with a single name
    that was not reached through a symbolic link. The checks are made on the
    opened descriptor and on the name after the open, so a link swapped in
    around the open is caught even where O_NOFOLLOW is unavailable."""
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    try:
        descriptor = os.open(target, flags, 0o600)
    except OSError:
        return None
    try:
        opened = os.fstat(descriptor)
        named = os.lstat(target)
        same = (named.st_ino, named.st_dev) == (opened.st_ino, opened.st_dev)
        if _is_private_regular(opened) and not stat.S_ISLNK(named.st_mode) and same:
            return descriptor
    except OSError:
        pass
    os.close(descriptor)
    return None


def read_text_if_regular(target: Path) -> str:
    """The text of `target` when it is a regular file with a single name
    (neither a symbolic nor a hard link), read from the checked descriptor."""
    descriptor = _open_private(target, os.O_RDONLY)
    if descriptor is None:
        return ""
    with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
        return handle.read()


def append_text_private(target: Path, text: str) -> bool:
    """Append `text` to `target`, creating it when missing, never through a
    link and never partially: the whole buffer is written on the checked
    descriptor. Concurrent appends keep each other's lines."""
    descriptor = _open_private(target, os.O_WRONLY | os.O_APPEND | os.O_CREAT)
    if descriptor is None:
        return False
    data = text.encode("utf-8")
    try:
        while data:
            data = data[os.write(descriptor, data):]
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
