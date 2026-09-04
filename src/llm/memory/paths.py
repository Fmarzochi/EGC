"""
Path hygiene for the memory providers: a category, a session id or a title
supplied by a caller names one entry under the provider's root and nothing
else.
"""
import os
import re
import secrets
import stat
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



def _is_private_regular(status: os.stat_result) -> bool:
    """A regular file with a single name: not a link of any kind."""
    return stat.S_ISREG(status.st_mode) and status.st_nlink == 1


def _write_all(descriptor: int, data: bytes) -> None:
    """Write the whole buffer; a write that makes no progress is an error,
    never a spin."""
    view = memoryview(data)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("write made no progress")
        view = view[written:]


_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_BINARY = getattr(os, "O_BINARY", 0)
_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
# Directory descriptors bind every operation to the directory that was
# checked; where the platform has none (Windows), operations use the path.
_DIRECTORY_DESCRIPTORS = bool(_DIRECTORY) and all(
    operation in os.supports_dir_fd for operation in (os.open, os.stat, os.replace, os.unlink)
)


class PrivateDirectory:
    """A category directory the provider works in. Where the platform allows
    it the directory is held open as a descriptor obtained without following
    links, and every file operation is relative to that descriptor, so a
    directory swapped for a link after the check can no longer redirect
    anything. Elsewhere the operations use the directory path, with the same
    per-file checks."""

    def __init__(self, path: Path):
        self.path = path
        self.descriptor: Optional[int] = None
        if _DIRECTORY_DESCRIPTORS:
            descriptor = os.open(path, os.O_RDONLY | _DIRECTORY | _NOFOLLOW)
            if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
                os.close(descriptor)
                raise NotADirectoryError(str(path))
            self.descriptor = descriptor

    def __enter__(self) -> "PrivateDirectory":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self.descriptor is not None:
            os.close(self.descriptor)
            self.descriptor = None

    def _where(self) -> dict:
        return {"dir_fd": self.descriptor} if self.descriptor is not None else {}

    def _target(self, name: str) -> str:
        return name if self.descriptor is not None else str(self.path / name)

    def _lstat(self, name: str) -> Optional[os.stat_result]:
        try:
            return os.lstat(self._target(name), **self._where())
        except OSError:
            return None

    def _open_private(self, name: str, flags: int) -> Optional[int]:
        """A descriptor on `name` when it is a regular file with a single
        name that was not reached through a symbolic link. The name is
        checked before the open (so, without O_NOFOLLOW, nothing is created
        behind a dangling link) and the opened descriptor is compared with
        the name after the open."""
        named = self._lstat(name)
        if named is not None and stat.S_ISLNK(named.st_mode):
            return None
        try:
            descriptor = os.open(self._target(name), flags | _NOFOLLOW | _BINARY, 0o600, **self._where())
        except OSError:
            return None
        try:
            opened = os.fstat(descriptor)
            named = os.lstat(self._target(name), **self._where())
            same = (named.st_ino, named.st_dev) == (opened.st_ino, opened.st_dev)
            if _is_private_regular(opened) and not stat.S_ISLNK(named.st_mode) and same:
                return descriptor
        except OSError:
            pass
        os.close(descriptor)
        return None

    def read_text(self, name: str) -> str:
        """The text of `name` when it is a regular file with a single name,
        read from the checked descriptor; '' otherwise."""
        descriptor = self._open_private(name, os.O_RDONLY)
        if descriptor is None:
            return ""
        with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
            return handle.read()

    def append_text(self, name: str, text: str) -> bool:
        """Append `text` to `name`, creating it when missing, never through a
        link and never partially. Concurrent appends keep each other's lines."""
        descriptor = self._open_private(name, os.O_WRONLY | os.O_APPEND | os.O_CREAT)
        if descriptor is None:
            return False
        try:
            _write_all(descriptor, text.encode("utf-8"))
            return True
        finally:
            os.close(descriptor)

    def write_text_atomic(self, name: str, text: str) -> None:
        """Replace `name` with `text` through a unique temporary sibling and a
        rename, so a link (hard or symbolic) planted at the name is replaced,
        never written through; the existing file's mode is kept and the
        temporary never survives a failure."""
        existing = self._lstat(name)
        mode = stat.S_IMODE(existing.st_mode) if existing is not None and stat.S_ISREG(existing.st_mode) else None
        temporary = f".{name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
        descriptor = os.open(self._target(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _BINARY, 0o600, **self._where())
        try:
            _write_all(descriptor, text.encode("utf-8"))
            if mode is not None:
                self._chmod(descriptor, temporary, mode)
            os.close(descriptor)
            descriptor = None
            replace_where = {"src_dir_fd": self.descriptor, "dst_dir_fd": self.descriptor} if self.descriptor is not None else {}
            os.replace(self._target(temporary), self._target(name), **replace_where)
        except BaseException:
            if descriptor is not None:
                os.close(descriptor)
            try:
                os.unlink(self._target(temporary), **self._where())
            except OSError:
                pass
            raise

    def _chmod(self, descriptor: int, temporary: str, mode: int) -> None:
        if os.chmod in os.supports_fd:
            os.chmod(descriptor, mode)
        else:
            os.chmod(self._target(temporary), mode)


def resolve_inside(root: Path, *parts: str) -> Optional[Path]:
    """The path root/parts, or None when it would resolve outside the root."""
    base = root.resolve()
    candidate = base.joinpath(*parts).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        return None
    return candidate
