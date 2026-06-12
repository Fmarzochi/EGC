"""
Memory Manager for EGC Cognitive Infrastructure.
Orchestrates multiple memory providers and handles configuration-driven activation.
"""
import os
import json
from typing import Optional, Dict

from llm.memory.base import CognitiveMemoryProvider, MemoryEntry
from llm.memory.providers.local import LocalFileProvider
from llm.memory.providers.obsidian import ObsidianVaultProvider
from llm.memory.providers.mcp_obsidian import MCPObsidianProvider

class MemoryManager:
    def __init__(self, workspace_root: str):
        self.workspace_root = workspace_root
        self.config = self._load_config()
        self.provider: Optional[CognitiveMemoryProvider] = self._initialize_provider()

    def _load_config(self) -> Dict:
        """
        Loads memory configuration from egc_settings.json or .mcp.json fallback.
        """
        settings_path = os.path.join(self.workspace_root, "egc_settings.json")
        if os.path.exists(settings_path):
            try:
                with open(settings_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return data.get("cognitiveMemory", {})
            except Exception:
                pass
        
        # Fallback to .mcp.json custom fields if any (though not standard)
        return {}

    def _initialize_provider(self) -> Optional[CognitiveMemoryProvider]:
        if not self.config.get("enabled", False):
            return None

        provider_type = self.config.get("provider", "local")
        namespace = self.config.get("namespace", "EGC")
        scope = self.config.get("scope", "sandboxed")

        if provider_type == "obsidian":
            vault_path = self.config.get("vaultPath")
            if vault_path:
                p = ObsidianVaultProvider(vault_path, namespace=namespace)
                if p.initialize():  # NOSONAR
                    return p

        elif provider_type == "obsidian-mcp":
            p = MCPObsidianProvider(namespace=namespace, scope=scope)
            if p.initialize():
                return p

        # Fallback to local
        p = LocalFileProvider(self.workspace_root, namespace=namespace)
        if p.initialize():  # NOSONAR
            return p
        
        return None

    def record_session_start(self, session_id: str, metadata: Dict):
        if self.provider and self.config.get("writeSessions", True):
            entry = MemoryEntry(
                title=f"Session {session_id}",
                content=f"Session started with metadata: {json.dumps(metadata, indent=2)}",
                category="Sessions",
                tags=["session-start"],
                metadata={"session_id": session_id, **metadata}
            )
            self.provider.write_note(entry)
            self.provider.append_journal("Sessions", f"Started session {session_id}")

    def record_session_end(self, session_id: str, summary: str):
        if self.provider and self.config.get("writeSessions", True):
            entry = MemoryEntry(
                title=f"Session {session_id} Summary",
                content=summary,
                category="Sessions",
                tags=["session-end", "summary"],
                metadata={"session_id": session_id}
            )
            self.provider.write_note(entry)
            self.provider.append_journal("Sessions", f"Completed session {session_id}")

    def log_archaeology(self, title: str, content: str, tags: list = None):
        if self.provider and self.config.get("writeArchaeology", True):
            entry = MemoryEntry(
                title=title,
                content=content,
                category="Archaeology",
                tags=tags or ["discovery"],
                metadata={}
            )
            self.provider.write_note(entry)
            self.provider.append_journal("Archaeology", f"New discovery: {title}")

    def log_governance(self, title: str, content: str):
        if self.provider and self.config.get("writeGovernance", True):
            entry = MemoryEntry(
                title=title,
                content=content,
                category="Governance",
                tags=["decision"],
                metadata={}
            )
            self.provider.write_note(entry)
            self.provider.append_journal("Governance", f"Decision recorded: {title}")
