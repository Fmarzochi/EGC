"""
Local filesystem implementation of the Cognitive Memory Provider.
"""
from pathlib import Path

from llm.memory.providers.filesystem import FilesystemMemoryProvider


class LocalFileProvider(FilesystemMemoryProvider):
    def __init__(self, workspace_root: str, namespace: str = "EGC"):
        super().__init__(Path(workspace_root) / ".sessions" / "memory" / namespace, namespace)
