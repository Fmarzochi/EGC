import logging
import asyncio
from typing import Callable, Any, Optional, List

logger = logging.getLogger("EGC.Fallback")

class FALLBACK_MANAGER:
    """
    EGC Fallback Manager
    Handles retries and re-routing logic when an agent or tool fails (Async version).
    """

    def __init__(self, max_retries: int = 2):
        self.max_retries = max_retries

    async def execute_with_retry_async(self, func: Callable, *args, **kwargs) -> Any:
        """
        Executes an async function with a retry loop.
        """
        last_exception = None
        for attempt in range(self.max_retries + 1):
            try:
                if attempt > 0:
                    logger.info(f"Retry attempt {attempt} for {func.__name__}...")
                    await asyncio.sleep(1) # Async Backoff
                return await func(*args, **kwargs)
            except Exception as e:
                last_exception = e
                logger.warning(f"Execution failure on attempt {attempt}: {str(e)}")
        
        logger.error(f"Max retries reached for {func.__name__}. Final failure.")
        raise last_exception

    def get_alternative_agents(self, failed_agent_id: str, domain_agents: List[str]) -> List[str]:
        """
        Returns a list of alternative agents excluding the one that just failed.
        """
        return [agent for agent in domain_agents if agent != failed_agent_id]

if __name__ == "__main__":
    async def main():
        async def failing_tool():
            raise TimeoutError("Tool Timeout")

        fm = FALLBACK_MANAGER()
        try:
            await fm.execute_with_retry_async(failing_tool)
        except Exception as e:
            print(f"Caught final exception: {e}")

    asyncio.run(main())
