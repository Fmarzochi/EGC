"""Memory providers keep every note under their root: a category, a title
or a session id supplied by a caller cannot climb out (security audit
2026-08-17, day 11)."""

import tempfile
import unittest
from pathlib import Path

from llm.memory.base import MemoryEntry
from llm.memory.paths import resolve_inside, safe_segment, safe_title
from llm.memory.providers.local import LocalFileProvider
from llm.memory.providers.obsidian import ObsidianVaultProvider


class MemoryProviderPathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def entry(title, category):
        return MemoryEntry(title=title, content="body", category=category, tags=["t"], metadata={})

    def providers(self):
        local = LocalFileProvider(str(self.base / "ws"))
        self.assertTrue(local.initialize())
        vault = self.base / "vault"
        vault.mkdir()
        obsidian = ObsidianVaultProvider(str(vault))
        self.assertTrue(obsidian.initialize())
        return [local, obsidian]

    def files_outside(self, roots):
        resolved = [root.resolve() for root in roots]
        return [
            path for path in self.base.rglob("*")
            if path.is_file() and not any(root in path.resolve().parents for root in resolved)
        ]

    def test_segments_and_titles(self):
        self.assertEqual(safe_segment("Sessions"), "Sessions")
        self.assertEqual(safe_segment("run-2026.09"), "run-2026.09")
        for bad in ["../etc", "a/b", "..", ".", "", "a\\b", ".hidden", None]:
            self.assertIsNone(safe_segment(bad), bad)
        self.assertEqual(safe_title("My note / v2"), "My_note___v2")
        self.assertIsNone(safe_title("../../"))
        self.assertIsNone(safe_title(""))
        root = self.base / "r"
        root.mkdir()
        self.assertIsNone(resolve_inside(root, "..", "x"))
        self.assertEqual(resolve_inside(root, "a", "b.md"), (root / "a" / "b.md").resolve())

    def test_traversal_is_refused(self):
        providers = self.providers()
        for provider in providers:
            self.assertFalse(provider.write_note(self.entry("evil", "../../outside")))
            self.assertTrue(provider.write_note(self.entry("../../evil", "Sessions")))
            self.assertTrue((provider.root / "Sessions" / "evil.md").exists())
            self.assertFalse(provider.write_note(self.entry("evil", "Sessions/../../outside")))
            self.assertFalse(provider.append_journal("../outside", "x"))
            self.assertFalse(provider.append_journal("Nowhere", "x"))
            self.assertIsNone(provider.get_session_summary("../../etc/passwd"))
        self.assertEqual(self.files_outside([provider.root for provider in providers]), [])

    def test_plain_names_work(self):
        for provider in self.providers():
            self.assertTrue(provider.write_note(self.entry("Decision one", "Governance")))
            self.assertTrue((provider.root / "Governance" / "Decision_one.md").exists())
            self.assertTrue(provider.append_journal("Sessions", "note"))
            self.assertTrue((provider.root / "Sessions" / "Journal.md").exists())
            (provider.root / "Sessions" / "session_abc-1.md").write_text("summary", encoding="utf-8")
            self.assertEqual(provider.get_session_summary("abc-1"), "summary")
            self.assertIsNone(provider.get_session_summary("missing"))


if __name__ == "__main__":
    unittest.main()
