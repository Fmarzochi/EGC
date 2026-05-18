import importlib
import importlib.util
import inspect
import os
import sys
import unittest
from unittest.mock import patch

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DASHBOARD_PATH = os.path.join(REPO_ROOT, "egc_dashboard.py")


def _load_dashboard_module():
    if REPO_ROOT not in sys.path:
        sys.path.insert(0, REPO_ROOT)
    src_path = os.path.join(REPO_ROOT, "src")
    if src_path not in sys.path:
        sys.path.insert(0, src_path)
    scripts_path = os.path.join(REPO_ROOT, "scripts")
    if scripts_path not in sys.path:
        sys.path.insert(0, scripts_path)

    import tkinter as tk

    with patch.object(tk.Tk, "mainloop", lambda self, *a, **kw: None), \
         patch.object(tk.Tk, "deiconify", lambda self, *a, **kw: None), \
         patch.object(tk.Tk, "withdraw", lambda self, *a, **kw: None), \
         patch.object(tk, "PhotoImage", autospec=False, create=True):
        spec = importlib.util.spec_from_file_location(
            "egc_dashboard_under_test", DASHBOARD_PATH
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class DashboardSmokeTests(unittest.TestCase):
    mod = None
    load_error = None

    @classmethod
    def setUpClass(cls):
        try:
            import tkinter  # noqa: F401
        except Exception as exc:
            cls.load_error = exc
            return
        try:
            cls.mod = _load_dashboard_module()
        except Exception as exc:
            cls.load_error = exc

    def setUp(self):
        if self.load_error is not None:
            self.skipTest(f"Tk/dashboard unavailable: {self.load_error!r}")

    def test_module_loads_without_launching_tk(self):
        mod = self.mod
        self.assertTrue(hasattr(mod, "EGCDashboard"))
        for fn_name in (
            "get_project_path",
            "parse_frontmatter",
            "load_agents",
            "load_skills",
            "load_commands",
            "load_rules",
            "infer_cognitive_metadata",
        ):
            self.assertTrue(
                hasattr(mod, fn_name),
                f"top-level helper {fn_name} missing from egc_dashboard",
            )
            self.assertTrue(callable(getattr(mod, fn_name)))

    def test_egc_dashboard_subprocess_execute_methods_present(self):
        cls = self.mod.EGCDashboard
        for name in (
            "_on_execute_run",
            "_poll_execute_output",
            "_append_execute_output",
            "create_execute_tab",
        ):
            self.assertTrue(
                hasattr(cls, name),
                f"EGCDashboard missing subprocess Execute method: {name}",
            )
            self.assertTrue(callable(getattr(cls, name)))

    def test_egc_dashboard_orchestrator_execute_methods_present(self):
        cls = self.mod.EGCDashboard
        for name in (
            "_ensure_orch_loop",
            "_on_execute_run_orchestrated",
            "_poll_execute_output_orchestrated",
            "_poll_orch_health",
        ):
            self.assertTrue(
                hasattr(cls, name),
                f"EGCDashboard missing orchestrator Execute method: {name}",
            )
            self.assertTrue(callable(getattr(cls, name)))

    def test_egc_dashboard_logo_loader_targets_canonical_asset(self):
        source = inspect.getsource(self.mod.EGCDashboard._load_logo)
        self.assertIn("egc-logo.png", source)
        self.assertNotIn("ecc-logo.png", source)

    def test_egc_dashboard_class_inherits_from_tk(self):
        tk = importlib.import_module("tkinter")
        self.assertTrue(issubclass(self.mod.EGCDashboard, tk.Tk))


if __name__ == "__main__":
    unittest.main()
