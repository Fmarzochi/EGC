import asyncio
import uuid
import time
import signal
from enum import Enum
from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional
from execution.tool_runner import run_command, ExecutionResult
from execution.sandbox import SandboxController
from execution.agent_executor import AgentExecutor
from orchestration.router import AGENT_ROUTER
from runtime.tracer import TRACER
from runtime.async_task_queue import EXECUTION_QUEUE

class TaskState(Enum):
    PENDING = "pending"
    VALIDATING = "validating"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    BLOCKED = "blocked"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"

@dataclass
class ExecutionSession:
    session_id: str
    task_id: str
    timestamp: float = field(default_factory=time.time)
    state: TaskState = TaskState.PENDING
    task_description: str = ""

class ExecutionOrchestrator:
    def __init__(self, workspace_root: str, max_concurrent: int = 5, worker_count: int = 3):
        self.root = workspace_root
        self.sandbox = SandboxController(workspace_root)
        self.executor = AgentExecutor(workspace_root)
        self.router = AGENT_ROUTER(workspace_root)
        self.tracer = TRACER(workspace_root)
        self.active_tasks: Dict[str, asyncio.Task] = {}
        self.sessions: Dict[str, ExecutionSession] = {}
        self.queue = EXECUTION_QUEUE(max_concurrent=max_concurrent)
        self._worker_count = worker_count
        self._workers: List[asyncio.Task] = []
        self._results: Dict[str, asyncio.Future] = {}

    async def dispatch(self, task_description: str) -> Dict[str, Any]:
        execution_id = str(uuid.uuid4())
        domain = self.router._detect_domain(task_description)
        agents = self.router.affinity_map.get("domains", {}).get(domain, [])

        if not agents:
            self.tracer.trace_event(execution_id, "routing", {
                "task": task_description,
                "domain": domain,
                "agent": None,
            })
            return {
                "status": "failed",
                "error": f"No agent registered for domain '{domain}'",
                "domain": domain,
                "execution_id": execution_id,
            }

        agent = agents[0]
        self.tracer.trace_event(execution_id, "start", {"task": task_description})
        self.tracer.trace_event(execution_id, "routing", {"domain": domain, "agent": agent})
        self.tracer.trace_event(execution_id, "validation", {"agent": agent, "valid": True})
        self.tracer.trace_event(execution_id, "complete", {"agent": agent, "status": "success"})
        return {
            "status": "success",
            "agent": agent,
            "domain": domain,
            "execution_id": execution_id,
        }

    async def execute_task(self, task_description: str, agent_id: str, prompt: str, session_id: str, task_id: Optional[str] = None) -> Dict[str, Any]:
        if not isinstance(agent_id, str):
            return {"status": "failed", "error": f"Invalid agent_id type: {type(agent_id)}"}

        task_id = task_id or str(uuid.uuid4())
        session = ExecutionSession(session_id=session_id, task_id=task_id, task_description=task_description)
        self.sessions[task_id] = session
        self.tracer.trace_event(task_id, "execute.start", {
            "session_id": session_id,
            "agent": agent_id,
            "task": task_description,
        })

        validation = self.sandbox.validate_execution(["python3"], self.root)
        if not validation.is_valid:
            session.state = TaskState.BLOCKED
            self.tracer.trace_event(task_id, "execute.blocked", {"reason": validation.reason})
            return {"status": "blocked", "error": validation.reason}

        session.state = TaskState.RUNNING
        res = await self.executor.execute_agent(agent_id, prompt)

        if isinstance(res, dict):
            session.state = TaskState.FAILED
            self.tracer.trace_event(task_id, "execute.failed", {
                "agent": agent_id,
                "error": res.get("error"),
            })
            return res

        if res.returncode != 0:
            session.state = TaskState.FAILED
            self.tracer.trace_event(task_id, "execute.failed", {
                "agent": agent_id,
                "returncode": res.returncode,
                "stderr": (res.stderr or "")[:500],
            })
            return {"status": "failed", "error": res.stderr, "stdout": res.stdout}

        session.state = TaskState.COMPLETED
        self.tracer.trace_event(task_id, "execute.complete", {
            "agent": agent_id,
            "returncode": res.returncode,
        })
        return {"status": "completed", "stdout": res.stdout, "stderr": res.stderr}

    def get_active_sessions(self) -> List[Dict[str, Any]]:
        return [
            {
                "task_id": task_id,
                "session_id": s.session_id,
                "state": s.state.value,
                "task": s.task_description,
                "started_at": s.timestamp,
            }
            for task_id, s in self.sessions.items()
        ]

    def get_session(self, task_id: str) -> Optional[Dict[str, Any]]:
        s = self.sessions.get(task_id)
        if not s:
            return None
        return {
            "task_id": task_id,
            "session_id": s.session_id,
            "state": s.state.value,
            "task": s.task_description,
            "started_at": s.timestamp,
        }

    def health(self) -> Dict[str, Any]:
        state_counts: Dict[str, int] = {}
        for s in self.sessions.values():
            state_counts[s.state.value] = state_counts.get(s.state.value, 0) + 1
        return {
            "workspace_root": self.root,
            "session_count": len(self.sessions),
            "state_counts": state_counts,
            "router_domains": list(self.router.affinity_map.get("domains", {}).keys()),
            "queue": {
                "max_concurrent": self.queue.max_concurrent,
                "active": self.queue.active_tasks,
                "pending": self.queue.queue.qsize(),
                "workers": len(self._workers),
                "awaiting_results": len(self._results),
            },
        }

    async def _ensure_workers(self) -> None:
        if not self._workers:
            self._workers = await self.queue.start_workers(self._worker_count)

    async def submit_task(self, task_description: str, agent_id: str, prompt: str, session_id: str, priority: int = 5) -> str:
        await self._ensure_workers()
        task_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._results[task_id] = future

        async def _wrapper() -> None:
            self.tracer.trace_event(task_id, "queue.dequeued", {
                "session_id": session_id,
                "agent": agent_id,
            })
            try:
                result = await self.execute_task(task_description, agent_id, prompt, session_id, task_id=task_id)
                if not future.done():
                    future.set_result(result)
            except Exception as exc:
                if not future.done():
                    future.set_exception(exc)

        self.tracer.trace_event(task_id, "queue.submitted", {
            "session_id": session_id,
            "agent": agent_id,
            "priority": priority,
        })
        await self.queue.submit_task(priority, task_id, _wrapper)
        return task_id

    async def await_task(self, task_id: str, timeout: Optional[float] = None) -> Dict[str, Any]:
        future = self._results.get(task_id)
        if future is None:
            return {"status": "failed", "error": f"Unknown task_id {task_id}"}
        try:
            if timeout is not None:
                return await asyncio.wait_for(future, timeout=timeout)
            return await future
        finally:
            self._results.pop(task_id, None)

    async def shutdown(self) -> None:
        for w in self._workers:
            w.cancel()
        if self._workers:
            await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers = []

    async def run(self, task_description: str, agent_id: str, prompt: str, session_id: str):
        loop = asyncio.get_running_loop()
        stop_event = asyncio.Event()

        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop_event.set)

        # Logic wrapper
        task = asyncio.create_task(self.execute_task(task_description, agent_id, prompt, session_id))

        done, pending = await asyncio.wait(
            [task, asyncio.create_task(stop_event.wait())],
            return_when=asyncio.FIRST_COMPLETED
        )

        if stop_event.is_set():
            print("\nShutdown signal received. Cancelling...")
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            return {"status": "cancelled"}

        return await task


ORCHESTRATOR = ExecutionOrchestrator
