import asyncio
import json
import os
import shutil
import tempfile
import time
import unittest
from unittest.mock import patch

from scripts.execution.tool_runner import ExecutionResult
from scripts.orchestration.orchestrator import ExecutionOrchestrator
from scripts.workflows.workflow_engine import WorkflowEngine


def _make_plan(n: int = 3):
    return [
        {"id": f"t{i}", "agent": f"agent-{i}", "prompt": f"prompt-{i}"}
        for i in range(n)
    ]


def _make_fake_executor(delay: float = 0.02):
    async def fake_execute_agent(agent_id, prompt, timeout=60):
        await asyncio.sleep(delay)
        return ExecutionResult(
            stdout=f"{agent_id}:{prompt}",
            stderr="",
            returncode=0,
        )
    return fake_execute_agent


class TestWorkflowEngine(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.mkdtemp(prefix="egc-wf-")
        os.makedirs(os.path.join(self.tmp, ".sessions", "workflows"), exist_ok=True)

    async def asyncTearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    async def test_sequential_mode_runs_in_plan_order(self):
        engine = WorkflowEngine(self.tmp)
        plan = _make_plan(3)
        engine.executor.execute_agent = _make_fake_executor(0.02)

        with patch.object(engine.planner, "plan", return_value=plan):
            state = await engine.run("main-task", "session-seq")

        self.assertEqual(state.state, "completed")
        self.assertEqual(list(state.results.keys()), ["t0", "t1", "t2"])
        for tid, res in state.results.items():
            self.assertTrue(hasattr(res, "stdout"))
            self.assertTrue(hasattr(res, "returncode"))
            self.assertEqual(res.returncode, 0)

    async def test_parallel_mode_runs_with_orchestrator(self):
        orch = ExecutionOrchestrator(self.tmp, max_concurrent=3)
        orch.executor.execute_agent = _make_fake_executor(0.02)
        try:
            engine = WorkflowEngine(self.tmp, orchestrator=orch)
            plan = _make_plan(3)

            with patch.object(engine.planner, "plan", return_value=plan):
                state = await engine.run(
                    "main-task",
                    "session-par",
                    parallel=True,
                    max_concurrent=3,
                )

            self.assertEqual(state.state, "completed")
            self.assertEqual(list(state.results.keys()), ["t0", "t1", "t2"])
            for tid, res in state.results.items():
                self.assertIsInstance(res, dict)
                self.assertEqual(res.get("status"), "completed")
        finally:
            await orch.shutdown()

    async def test_parallel_mode_faster_than_sequential(self):
        plan = _make_plan(5)
        per_task_delay = 0.05

        engine_seq = WorkflowEngine(self.tmp)
        engine_seq.executor.execute_agent = _make_fake_executor(per_task_delay)
        with patch.object(engine_seq.planner, "plan", return_value=plan):
            seq_start = time.perf_counter()
            seq_state = await engine_seq.run("main-task", "session-seq-bench")
            seq_elapsed = time.perf_counter() - seq_start

        orch = ExecutionOrchestrator(self.tmp, max_concurrent=5)
        orch.executor.execute_agent = _make_fake_executor(per_task_delay)
        try:
            engine_par = WorkflowEngine(self.tmp, orchestrator=orch)
            with patch.object(engine_par.planner, "plan", return_value=plan):
                par_start = time.perf_counter()
                par_state = await engine_par.run(
                    "main-task",
                    "session-par-bench",
                    parallel=True,
                    max_concurrent=5,
                )
                par_elapsed = time.perf_counter() - par_start
        finally:
            await orch.shutdown()

        self.assertEqual(seq_state.state, "completed")
        self.assertEqual(par_state.state, "completed")
        self.assertLess(
            par_elapsed,
            seq_elapsed * 0.7,
            msg=f"parallel={par_elapsed*1000:.1f}ms sequential={seq_elapsed*1000:.1f}ms",
        )

    async def test_persist_creates_workflow_file(self):
        engine = WorkflowEngine(self.tmp)
        plan = _make_plan(2)
        engine.executor.execute_agent = _make_fake_executor(0.01)

        with patch.object(engine.planner, "plan", return_value=plan):
            state = await engine.run("main-task", "session-persist")

        path = os.path.join(
            self.tmp, ".sessions", "workflows", f"{state.workflow_id}.json"
        )
        self.assertTrue(os.path.exists(path))

        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertEqual(data["workflow_id"], state.workflow_id)
        self.assertEqual(data["state"], "completed")
        self.assertIn("results", data)
        self.assertEqual(list(data["results"].keys()), ["t0", "t1"])


if __name__ == "__main__":
    unittest.main()
