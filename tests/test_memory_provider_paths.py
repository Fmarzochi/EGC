"""Memory providers keep every note under their root: a category, a title
or a session id supplied by a caller cannot climb out (security audit
2026-08-17, day 11)."""

import tempfile
import unittest

from pathlib import Path

from llm.memory.base import MemoryEntry
from llm.memory.paths import PrivateDirectory, resolve_inside, safe_segment, safe_title, supports_directory_descriptors


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
        self.assertEqual(safe_title("Réunion été"), "Réunion_été")

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

    def test_links_never_redirect_a_write(self):
        outside = self.base / "outside"
        outside.mkdir()
        victim = outside / "victim.md"
        victim.write_text("outside content", encoding="utf-8")
        for provider in self.providers():
            try:
                (provider.root / "Linked").symlink_to(outside, target_is_directory=True)
                (provider.root / "Governance" / "Aliased.md").hardlink_to(victim)
            except (OSError, NotImplementedError, AttributeError) as error:
                self.skipTest(f"links are not available here: {error}")
            self.assertFalse(provider.write_note(self.entry("note", "Linked")), "a linked category resolves outside the root")
            self.assertFalse(provider.append_journal("Linked", "x"))
            self.assertTrue(provider.write_note(self.entry("Aliased", "Governance")))
            self.assertEqual(victim.read_text(encoding="utf-8"), "outside content", "the hard link is replaced, not written through")
            self.assertIn("body", (provider.root / "Governance" / "Aliased.md").read_text(encoding="utf-8"))
            self.assertEqual([p for p in outside.iterdir()], [victim])
            other = provider.root / "Traces" / "Journal.md"
            other.write_text("other", encoding="utf-8")
            (provider.root / "Archaeology" / "Journal.md").symlink_to(other)
            self.assertFalse(provider.append_journal("Archaeology", "x"), "a journal that is a link is not appended")
            self.assertEqual(other.read_text(encoding="utf-8"), "other")
            (provider.root / "Aliased-category").symlink_to(provider.root / "Traces", target_is_directory=True)
            self.assertFalse(provider.write_note(self.entry("note", "Aliased-category")), "a category that links another one is refused")
            planted = provider.root / "Sessions" / "Session_abc_def_Summary.md"
            planted.write_text("planted", encoding="utf-8")
            self.assertIsNone(provider.get_session_summary("abc/def"), "a session id with a separator names no session, even when its mangled name exists")
            self.assertEqual(provider.get_session_summary("abc_def"), "planted")



    def test_frontmatter_journal_and_summary(self):
        for provider in self.providers():
            tricky = MemoryEntry(title='Quote " and\nnewline', content="body", category="Governance",
                                 tags=["a, b"], metadata={"k": 'v"\n---\nevil: yes'})
            self.assertTrue(provider.write_note(tricky))
            note = next(provider.root.joinpath("Governance").glob("Quote_*.md")).read_text(encoding="utf-8")
            self.assertIn('title: "Quote \\" and\\nnewline"', note)
            self.assertNotIn("\nevil:", note)
            self.assertTrue(provider.append_journal("Governance", "first"))
            self.assertTrue(provider.append_journal("Governance", "second"))
            journal = (provider.root / "Governance" / "Journal.md").read_text(encoding="utf-8")
            self.assertIn("first", journal)
            self.assertIn("second", journal)
            self.assertIsNone(provider.get_session_summary("s1"))
            self.assertTrue(provider.write_note(self.entry("Session s1 Summary", "Sessions")))
            self.assertIn("body", provider.get_session_summary("s1") or "")
            self.assertEqual([p.name for p in provider.root.joinpath("Governance").iterdir() if p.name.endswith(".tmp")], [])

    def test_directory_is_held_by_descriptor_where_supported(self):
        if not supports_directory_descriptors():
            self.skipTest("no directory descriptors on this platform")

        with PrivateDirectory(self.base) as directory:
            self.assertIsNotNone(directory.descriptor, "POSIX must bind the directory by descriptor")
            directory.write_text_atomic("held.md", "held")
            self.assertTrue(directory.append_text("held.md", " more"))
            self.assertEqual(directory.read_text("held.md"), "held more")

    def test_plain_names_work(self):
        for provider in self.providers():
            self.assertTrue(provider.write_note(self.entry("Decision one", "Governance")))
            self.assertTrue((provider.root / "Governance" / "Decision_one.md").exists())
            self.assertTrue(provider.append_journal("Sessions", "note"))
            self.assertTrue((provider.root / "Sessions" / "Journal.md").exists())
            (provider.root / "Sessions" / "Session_abc-1_Summary.md").write_text("summary", encoding="utf-8")
            self.assertEqual(provider.get_session_summary("abc-1"), "summary")
            self.assertIsNone(provider.get_session_summary("missing"))


if __name__ == "__main__":
    unittest.main()
