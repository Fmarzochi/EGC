import asyncio
import json
import os
from workflows.task_planner import TaskPlanner
from workflows.workflow_state import WorkflowState
from execution.agent_executor import AgentExecutor
from runtime.runtime_context import RuntimeContext
from orchestration.orchestrator import ExecutionOrchestrator

class WorkflowEngine:
    """
    [DORMANT / TEST-ONLY SYSTEM]
    The WorkflowEngine interprets and executes workflow specifications.
    This component is primarily an architectural mockup kept alive by the topology CI tests.
    Real workflows are handled by scripts/hooks or third-party harnesses.
    """
    def __init__(self, workspace_root: str, *, orchestrator=None):
        self.root = workspace_root
        self.planner = TaskPlanner()
        self.executor = AgentExecutor(workspace_root)
        self.workflow_dir = os.path.join(workspace_root, ".sessions/workflows")
        self.orchestrator = orchestrator

    async def run(self, main_task: str, session_id: str, *, parallel: bool = False, max_concurrent: int = 5):
        plan = self.planner.plan(main_task)
        state = WorkflowState()
        RuntimeContext(session_id, state.workflow_id)

        state.state = "running"

        if not parallel:
            for task in plan:
                res = await self.executor.execute_agent(task['agent'], task['prompt'])
                state.results[task['id']] = res
        else:
            owns_orchestrator = self.orchestrator is None
            orch = self.orchestrator or ExecutionOrchestrator(self.root, max_concurrent=max_concurrent)
            try:
                task_ids = []
                for task in plan:
                    tid = await orch.submit_task(
                        task_description=task.get('prompt', ''),
                        agent_id=task['agent'],
                        prompt=task['prompt'],
                        session_id=session_id,
                    )
                    task_ids.append((task['id'], tid))
                for plan_id, tid in task_ids:
                    result = await orch.await_task(tid, timeout=300)
                    state.results[plan_id] = result
            finally:
                if owns_orchestrator:
                    await orch.shutdown()

        state.state = "completed"
        self._persist(state)
        return state

    def _persist(self, state: WorkflowState):
        path = os.path.join(self.workflow_dir, f"{state.workflow_id}.json")
        serializable_results = {}
        for k, v in state.results.items():
            if hasattr(v, 'stdout'):
                serializable_results[k] = {
                    "stdout": v.stdout,
                    "stderr": v.stderr,
                    "returncode": v.returncode
                }
            else:
                serializable_results[k] = v

        data = {
            "workflow_id": state.workflow_id,
            "tasks": state.tasks,
            "results": serializable_results,
            "state": state.state
        }
        with open(path, 'w') as f:
            json.dump(data, f, indent=2)
