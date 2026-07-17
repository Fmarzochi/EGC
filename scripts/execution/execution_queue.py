import asyncio
import json
import os
from typing import Dict, Any, List
from dataclasses import asdict
from orchestration.orchestrator import ExecutionOrchestrator, TaskState

class ExecutionQueue:
    """
    [DORMANT / TEST-ONLY SYSTEM]
    The ExecutionQueue provides an async task processing loop.
    Currently, this acts as a simulated queue mechanism kept alive by unit tests.
    The real EGC system has no persistent background event loop for queues.
    """
    def __init__(self, workspace_root: str, concurrency: int = 3):
        self.queue = asyncio.Queue()
        self.concurrency = concurrency
        self.orchestrator = ExecutionOrchestrator(workspace_root)
        self.session_dir = os.path.join(workspace_root, ".sessions")
        self.running_tasks = {}
        self.workers = []

    async def start(self):  # NOSONAR
        self.workers = [asyncio.create_task(self._worker()) for _ in range(self.concurrency)]

    async def _worker(self):
        while True:
            task_data = await self.queue.get()
            task_id = task_data['task_id']
            try:
                self.running_tasks[task_id] = task_data
                print(f"[Queue] Worker started: {task_id}")
                
                result = await self.orchestrator.execute_task(
                    task_data['desc'], task_data['cmd'], task_data['cwd'], task_data['session_id']
                )
                
                self._persist_session(task_data, result)
            except Exception as e:
                print(f"[Queue] Worker failed: {task_id} with {str(e)}")
            finally:
                self.running_tasks.pop(task_id, None)
                self.queue.task_done()
                print(f"[Queue] Worker completed: {task_id}")

    def _persist_session(self, task_data: Dict, result: Dict):
        path = os.path.join(self.session_dir, f"session_{task_data['task_id']}.json")
        data = {**task_data, 'result': result}
        with open(path, 'w') as f:
            json.dump(data, f, indent=2)

    async def enqueue(self, task_id: str, desc: str, cmd: List[str], cwd: str, session_id: str):
        await self.queue.put({
            'task_id': task_id, 'desc': desc, 'cmd': cmd, 'cwd': cwd, 'session_id': session_id
        })

    async def shutdown(self):
        for worker in self.workers:
            worker.cancel()
        await asyncio.gather(*self.workers, return_exceptions=True)
