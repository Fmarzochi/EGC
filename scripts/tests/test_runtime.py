import asyncio
import os
import sys
import uuid
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from runtime.event_bus import EventBus
from runtime.memory_mesh import MemoryMesh
from runtime.runtime_context import RuntimeContext

async def test_runtime():
    bus = EventBus()
    mesh = MemoryMesh()
    ctx = RuntimeContext("sess-1", "wf-1")
    
    print("--- Running Runtime Tests ---")
    
    # 1. Test Event Bus
    results = []
    async def cb(d): results.append(d)  # NOSONAR
    await bus.subscribe("test", cb)
    await bus.emit("test", "data")
    await asyncio.sleep(0.1)
    assert results == ["data"]
    print("Test 1 (EventBus): PASS")
    
    # 2. Test Memory Mesh
    await mesh.put("key", "val", "wf-1")
    val = await mesh.get("key")
    assert val == "val"
    print("Test 2 (MemoryMesh): PASS")
    
    # 3. Test Runtime Context
    ctx.set_agent_context("ag1", {"data": "foo"})
    assert ctx.get_agent_context("ag1")["data"] == "foo"
    print("Test 3 (Context): PASS")

if __name__ == "__main__":
    asyncio.run(test_runtime())
