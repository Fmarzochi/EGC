import asyncio
import json
import os
import tempfile
import unittest

from scripts.execution.tool_runner import ExecutionResult
from scripts.orchestration.orchestrator import ORCHESTRATOR


def _seed_workspace(root: str) -> None:
    os.makedirs(os.path.join(root, "registry"), exist_ok=True)
    affinity = {"domains": {"test": ["agent-a"]}}
    with open(os.path.join(root, "AGENT_AFFINITY_MAP.json"), "w", encoding="utf-8") as f:
        json.dump(affinity, f)
    runtime = {
        "agents": [
            {"name": "agent-a.md", "physicalPath": "agents/agent-a.md", "status": "cold"},
        ]
    }
    with open(os.path.join(root, "registry", "runtime-map.json"), "w", encoding="utf-8") as f:
        json.dump(runtime, f)


def _make_success_executor(delay: float = 0.01):
    async def _fn(agent_id, prompt):
        await asyncio.sleep(delay)
        return ExecutionResult(stdout="ok", stderr="", returncode=0)
    return _fn


def _make_failed_executor():
    async def _fn(agent_id, prompt):
        await asyncio.sleep(0)
        return {"status": "failed", "error": "x"}
    return _fn


class TestOrchestratorQueue(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        _seed_workspace(self.root)
        self.orch = ORCHESTRATOR(self.root, max_concurrent=3, worker_count=3)

    async def asyncTearDown(self):
        try:
            await self.orch.shutdown()
        finally:
            self._tmp.cleanup()

    async def test_submit_task_returns_task_id_and_completes(self):
        self.orch.executor.execute_agent = _make_success_executor(0.01)
        task_id = await self.orch.submit_task("task", "agent-a", "prompt", "session-1")
        self.assertIsInstance(task_id, str)
        self.assertEqual(len(task_id), 36)
        result = await self.orch.await_task(task_id, timeout=2.0)
        self.assertEqual(result["status"], "completed")

    async def test_concurrent_throttle_at_max_concurrent(self):
        self.orch.executor.execute_agent = _make_success_executor(0.05)
        task_ids = []
        for i in range(12):
            tid = await self.orch.submit_task(f"task-{i}", "agent-a", "prompt", f"session-{i}")
            task_ids.append(tid)
        health = self.orch.health()
        self.assertEqual(health["queue"]["max_concurrent"], 3)
        self.assertLessEqual(health["queue"]["active"], 3)
        results = await asyncio.gather(
            *[self.orch.await_task(tid, timeout=10.0) for tid in task_ids]
        )
        completed = [r for r in results if r.get("status") == "completed"]
        self.assertEqual(len(completed), 12)

    async def test_health_dead_letters_block_present(self):
        health = self.orch.health()
        self.assertIn("dead_letters", health)
        self.assertEqual(health["dead_letters"]["count"], 0)

        self.orch.executor.execute_agent = _make_failed_executor()
        task_id = await self.orch.submit_task("task", "agent-a", "prompt", "session-fail")
        await self.orch.await_task(task_id, timeout=2.0)
        self.assertGreaterEqual(self.orch.health()["dead_letters"]["count"], 1)

    async def test_get_session_traces_returns_full_lifecycle(self):
        self.orch.executor.execute_agent = _make_success_executor(0.01)
        task_id = await self.orch.submit_task("task", "agent-a", "prompt", "session-trace")
        result = await self.orch.await_task(task_id, timeout=2.0)
        self.assertEqual(result["status"], "completed")

        traces = self.orch.get_session_traces(task_id)
        types_in_order = [e.get("type") for e in traces]
        required = ["queue.submitted", "queue.dequeued", "execute.start", "execute.complete"]
        for evt in required:
            self.assertIn(evt, types_in_order)
        positions = [types_in_order.index(evt) for evt in required]
        self.assertEqual(positions, sorted(positions))

    async def test_snapshot_bundles_health_sessions_traces(self):
        self.orch.executor.execute_agent = _make_success_executor(0.01)
        ids = []
        for i in range(2):
            ids.append(await self.orch.submit_task(f"task-{i}", "agent-a", "prompt", f"session-{i}"))
        await asyncio.gather(*[self.orch.await_task(tid, timeout=2.0) for tid in ids])

        snap = self.orch.snapshot()
        self.assertEqual(sorted(snap.keys()), ["health", "recent_traces", "sessions", "timestamp"])
        self.assertIsInstance(snap["health"], dict)
        self.assertIsInstance(snap["sessions"], list)
        self.assertIsInstance(snap["recent_traces"], list)
        self.assertIsInstance(snap["timestamp"], str)
        self.assertGreaterEqual(len(snap["sessions"]), 1)


class TestOrchestratorQueueDeadLetterCap(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        _seed_workspace(self.root)
        self.orch = ORCHESTRATOR(self.root, max_concurrent=1, worker_count=1)

    async def asyncTearDown(self):
        try:
            await self.orch.shutdown()
        finally:
            self._tmp.cleanup()

    async def test_get_dead_letters_caps_at_100(self):
        self.orch.executor.execute_agent = _make_failed_executor()
        first_five = []
        all_ids = []
        for i in range(105):
            tid = await self.orch.submit_task(
                f"task-{i}", "agent-a", "prompt", f"session-{i}", priority=i
            )
            all_ids.append(tid)
            if i < 5:
                first_five.append(tid)
        await asyncio.gather(
            *[self.orch.await_task(tid, timeout=20.0) for tid in all_ids]
        )

        dead = self.orch.get_dead_letters(limit=1000)
        self.assertEqual(len(dead), 100)
        self.assertNotIn(dead[0]["task_id"], first_five)


if __name__ == "__main__":
    unittest.main()
