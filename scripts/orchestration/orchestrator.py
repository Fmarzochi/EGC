import asyncio
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
    def __init__(self, workspace_root: str):
        self.root = workspace_root
        self.sandbox = SandboxController(workspace_root)
        self.executor = AgentExecutor(workspace_root)
        self.active_tasks: Dict[str, asyncio.Task] = {}
        self.sessions: Dict[str, ExecutionSession] = {}

    async def execute_task(self, task_description: str, agent_id: str, prompt: str, session_id: str) -> Dict[str, Any]:
        if not isinstance(agent_id, str):
            return {"status": "failed", "error": f"Invalid agent_id type: {type(agent_id)}"}

        task_id = str(uuid.uuid4())
        session = ExecutionSession(session_id=session_id, task_id=task_id, task_description=task_description)
        self.sessions[task_id] = session

        validation = self.sandbox.validate_execution(["python3"], self.root)
        if not validation.is_valid:
            session.state = TaskState.BLOCKED
            return {"status": "blocked", "error": validation.reason}

        session.state = TaskState.RUNNING

        print(f"[TRACE] orchestrator.execute_task | agent_id: {agent_id} | type: {type(agent_id)} | id: {id(agent_id)}")
        res = await self.executor.execute_agent(agent_id, prompt)

        if isinstance(res, dict):
            session.state = TaskState.FAILED
            return res

        if res.returncode != 0:
            session.state = TaskState.FAILED
            return {"status": "failed", "error": res.stderr, "stdout": res.stdout}

        session.state = TaskState.COMPLETED
        return {"status": "completed", "stdout": res.stdout, "stderr": res.stderr}

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
