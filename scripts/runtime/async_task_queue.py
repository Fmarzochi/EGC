import asyncio
import logging
from typing import Dict, Any, Callable, Awaitable

logger = logging.getLogger("EGC.ExecutionQueue")

class EXECUTION_QUEUE:
    """
    EGC Execution Queue
    Manages concurrent workflow executions with backpressure and prioritization.
    """
    
    def __init__(self, max_concurrent: int = 5):
        self.queue = asyncio.PriorityQueue()
        self.max_concurrent = max_concurrent
        self.active_tasks = 0
        self.semaphore = asyncio.Semaphore(max_concurrent)

    async def submit_task(self, priority: int, task_id: str, coro: Callable[..., Awaitable[Any]], *args, **kwargs):
        """
        Submits a task to the queue. Lower priority number means higher priority.
        """
        logger.info(f"Task {task_id} submitted to queue with priority {priority}")
        # PriorityQueue items are tuples of (priority, item)
        # We can't put coroutine functions directly if they don't support ordering,
        # so we wrap them in a tuple with an insertion order or task_id to break ties.
        await self.queue.put((priority, task_id, coro, args, kwargs))

    async def worker(self):
        """
        Worker that consumes tasks from the queue and executes them.
        """
        while True:
            priority, task_id, coro, args, kwargs = await self.queue.get()
            
            async with self.semaphore:
                self.active_tasks += 1
                logger.info(f"Worker processing task {task_id} (Priority {priority}). Active: {self.active_tasks}/{self.max_concurrent}")
                try:
                    async with asyncio.timeout(300.0):
                        result = await coro(*args, **kwargs)
                    logger.info(f"Task {task_id} completed successfully.")
                except TimeoutError:
                    logger.exception(f"Task {task_id} timed out.")
                except Exception:
                    logger.exception(f"Task {task_id} failed.")
                finally:
                    self.active_tasks -= 1
                    self.queue.task_done()

    async def start_workers(self, num_workers: int = 3):
        """
        Starts the worker pool.
        """
        workers = [asyncio.create_task(self.worker()) for _ in range(num_workers)]
        return workers

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    
    async def dummy_task(name):
        await asyncio.sleep(1)
        return f"Hello {name}"
        
    async def main():
        eq = EXECUTION_QUEUE(max_concurrent=2)
        workers = await eq.start_workers(2)
        
        await eq.submit_task(2, "task-1", dummy_task, "Task 1")
        await eq.submit_task(1, "task-2", dummy_task, "Task 2") # Higher priority
        await eq.submit_task(3, "task-3", dummy_task, "Task 3")
        
        await eq.queue.join()
        for w in workers:
            w.cancel()
            
    asyncio.run(main())
