"""
Base interface for Cognitive Memory Providers.
Ensures clean boundaries between the repository and external memory stores.
"""
from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field
from datetime import datetime

@dataclass
class MemoryEntry:
    title: str
    content: str
    category: str  # e.g., 'Sessions', 'Archaeology', 'Governance'
    tags: List[str]
    metadata: Dict[str, Any]
    timestamp: datetime = field(default_factory=datetime.now)

class CognitiveMemoryProvider(ABC):
    """
    Abstract base class for all cognitive memory providers.
    """
    
    @abstractmethod
    def initialize(self) -> bool:
        """Initialize the provider and ensure the storage backend is ready."""
        pass

    @abstractmethod
    def write_note(self, entry: MemoryEntry) -> bool:
        """Write a new note to the memory store."""
        pass

    @abstractmethod
    def append_journal(self, category: str, content: str) -> bool:
        """Append a snippet to a continuous journal/log file."""
        pass

    @abstractmethod
    def search_memory(self, query: str) -> List[MemoryEntry]:
        """Search the memory store for existing entries."""
        pass

    @abstractmethod
    def get_session_summary(self, session_id: str) -> Optional[str]:
        """Retrieve a summary of a specific session."""
        pass
