import asyncio
import os
import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from execution.agent_loader import AgentLoader

async def test_loader():  # NOSONAR
    root = os.getcwd()
    loader = AgentLoader(root)
    agents = loader.discover_agents()
    print(f"Discovered {len(agents)} agents.")
    assert len(agents) > 0

if __name__ == "__main__":
    asyncio.run(test_loader())
