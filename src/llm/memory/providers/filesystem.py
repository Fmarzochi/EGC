"""
Shared filesystem implementation of the Cognitive Memory Provider: notes live
under one root, and every name a caller supplies (category, title, session
id) is bound to that root before anything is read or written.
"""
import json
from datetime import datetime

from pathlib import Path
from typing import List, Optional

from llm.memory.base import CognitiveMemoryProvider, MemoryEntry
from llm.memory.paths import append_text_private, read_text_if_regular, resolve_inside, safe_segment, safe_title, write_text_atomic



class FilesystemMemoryProvider(CognitiveMemoryProvider):
    SUBDIRECTORIES = ("Sessions", "Archaeology", "Governance", "Traces")

    def __init__(self, root: Path, namespace: str = "EGC"):
        self.root = root
        self.namespace = namespace

    def initialize(self) -> bool:
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            for sub in self.SUBDIRECTORIES:
                (self.root / sub).mkdir(exist_ok=True)
            return True
        except Exception:
            return False

    def write_note(self, entry: MemoryEntry) -> bool:
        try:
            category = safe_segment(entry.category)
            stem = safe_title(entry.title)
            if category is None or stem is None:
                return False
            target_dir = self._real_directory(category)
            if target_dir is None:
                return False
            target_dir.mkdir(exist_ok=True)
            # The name as spelled, under a directory proven real: a link at the
            # note's own name is replaced by the atomic write, never followed.
            file_path = target_dir / f"{stem}.md"

            # Frontmatter (Standard YAML for Obsidian compatibility); every
            # value is a JSON scalar or list, which YAML reads as-is, so
            # quotes and newlines in a title or a metadata value stay data.
            lines = ["---", f"title: {json.dumps(str(entry.title))}", f"category: {json.dumps(str(entry.category))}",
                     f"tags: {json.dumps(['egc', *map(str, entry.tags)])}", f"timestamp: {entry.timestamp.isoformat()}"]
            lines.extend(f"{json.dumps(str(k))}: {json.dumps(str(v))}" for k, v in entry.metadata.items())
            lines.append("---")

            write_text_atomic(file_path, "\n".join(lines) + "\n\n" + entry.content)
            return True
        except Exception:
            return False

    def append_journal(self, category: str, content: str) -> bool:
        try:
            segment = safe_segment(category)
            target_dir = self._real_directory(segment) if segment else None
            if target_dir is None or not target_dir.is_dir():
                return False
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            return append_text_private(target_dir / "Journal.md", f"\n### {timestamp}\n\n{content}\n")


        except Exception:
            return False

    def search_memory(self, query: str) -> List[MemoryEntry]:
        # Placeholder for future indexed search
        return []

    def get_session_summary(self, session_id: str) -> Optional[str]:
        # A session id is one path segment; anything else names no session.
        if safe_segment(session_id) != session_id:
            return None
        sessions = self._real_directory("Sessions")
        if sessions is None:
            return None
        # The same naming as the note the session end writes ("Session <id>
        # Summary"), with the session start note as the fallback.
        for title in (f"Session {session_id} Summary", f"Session {session_id}"):
            stem = safe_title(title)
            text = read_text_if_regular(sessions / f"{stem}.md") if stem else ""
            if text:
                return text
        return None

    def _real_directory(self, segment: str) -> Optional[Path]:
        """The category directory as spelled, when it is inside the root and
        neither it nor the root is a symbolic link (a link inside the root
        would alias another category)."""
        lexical = self.root / segment
        if self.root.is_symlink() or lexical.is_symlink() or resolve_inside(self.root, segment) is None:
            return None
        return lexical


