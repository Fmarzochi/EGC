"""
Obsidian Vault implementation of the Cognitive Memory Provider.
"""
import os
from pathlib import Path

from llm.memory.providers.filesystem import FilesystemMemoryProvider


class ObsidianVaultProvider(FilesystemMemoryProvider):
    def __init__(self, vault_path: str, namespace: str = "EGC"):
        super().__init__(Path(os.path.expanduser(vault_path)) / namespace, namespace)

    def initialize(self) -> bool:
        if not self.root.parent.exists():
            return False  # Vault path must exist
        return super().initialize()
