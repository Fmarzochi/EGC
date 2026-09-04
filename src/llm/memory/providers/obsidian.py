"""
Obsidian Vault implementation of the Cognitive Memory Provider.
"""
import os
from typing import List, Optional
from pathlib import Path
from datetime import datetime

from llm.memory.base import CognitiveMemoryProvider, MemoryEntry
from llm.memory.paths import resolve_inside, safe_segment, safe_title


class ObsidianVaultProvider(CognitiveMemoryProvider):
    def __init__(self, vault_path: str, namespace: str = "EGC"):
        self.root = Path(os.path.expanduser(vault_path)) / namespace
        self.namespace = namespace

    def initialize(self) -> bool:
        try:
            if not self.root.parent.exists():
                return False  # Vault path must exist
            self.root.mkdir(parents=True, exist_ok=True)
            for sub in ["Sessions", "Archaeology", "Governance", "Traces"]:
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
            target_dir = resolve_inside(self.root, category)
            file_path = resolve_inside(self.root, category, f"{stem}.md")
            if target_dir is None or file_path is None:
                return False
            target_dir.mkdir(exist_ok=True)

            
            with open(file_path, "w", encoding="utf-8") as f:
                # Frontmatter (Standard YAML for Obsidian compatibility)
                f.write("---\n")
                f.write(f"title: \"{entry.title}\"\n")
                f.write(f"category: {entry.category}\n")
                f.write(f"tags: [egc, {', '.join(entry.tags)}]\n")
                f.write(f"timestamp: {entry.timestamp.isoformat()}\n")
                for k, v in entry.metadata.items():
                    f.write(f"{k}: \"{v}\"\n")
                f.write("---\n\n")
                f.write(entry.content)
            return True
        except Exception:
            return False

    def append_journal(self, category: str, content: str) -> bool:
        try:
            segment = safe_segment(category)
            journal_path = resolve_inside(self.root, segment, "Journal.md") if segment else None
            if journal_path is None or not journal_path.parent.is_dir():
                return False

            with open(journal_path, "a", encoding="utf-8") as f:
                timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                f.write(f"\n### {timestamp}\n\n{content}\n")
            return True
        except Exception:
            return False

    def search_memory(self, query: str) -> List[MemoryEntry]:
        # Placeholder for future Local REST API integration
        return []

    def get_session_summary(self, session_id: str) -> Optional[str]:
        segment = safe_segment(session_id)
        summary_path = resolve_inside(self.root, "Sessions", f"session_{segment}.md") if segment else None
        if summary_path is not None and summary_path.exists():

            with open(summary_path, "r", encoding="utf-8") as f:
                return f.read()
        return None
