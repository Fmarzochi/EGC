import asyncio
from typing import Dict, Any, Callable, List

class EventBus:
    def __init__(self):
        self.subscribers: Dict[str, List[Callable]] = {}
        self.lock = asyncio.Lock()
        self._tasks: List[asyncio.Task] = []

    async def subscribe(self, event_type: str, callback: Callable):
        async with self.lock:
            if event_type not in self.subscribers:
                self.subscribers[event_type] = []
            self.subscribers[event_type].append(callback)

    async def emit(self, event_type: str, data: Any):  # NOSONAR
        if event_type in self.subscribers:
            for callback in self.subscribers[event_type]:
                task = asyncio.create_task(callback(data))
                self._tasks.append(task)
                task.add_done_callback(self._tasks.remove)
