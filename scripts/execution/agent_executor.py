import logging
import os

from execution.agent_loader import AgentLoader
from execution.tool_runner import run_command


def _build_runtime_env(workspace_root: str, agent_id: str) -> dict:
    env = os.environ.copy()
    src_path = os.path.join(workspace_root, "src")
    existing_pp = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = src_path + (os.pathsep + existing_pp if existing_pp else "")
    if "EGC_SESSION_ID" not in env and "ECC_SESSION_ID" not in env:
        env["EGC_SESSION_ID"] = f"egc-{agent_id}"
    env.setdefault("EGC_PLUGIN_ROOT", workspace_root)
    env.setdefault("PROJECT_ROOT", os.getcwd())
    return env


class AgentExecutor:
    def __init__(self, workspace_root: str):
        self.workspace_root = workspace_root
        self.loader = AgentLoader(workspace_root)
        self.logger = logging.getLogger("AgentExecutor")

    async def execute_agent(self, agent_id: str, prompt: str, timeout: int = 60):
        agent_path = self.loader.load_agent(agent_id)
        if not agent_path:
            self.logger.error(f"Agent {agent_id} not found.")
            return {"status": "failed", "error": "Agent not found"}

        self.logger.info(f"Starting agent {agent_id} execution from {agent_path}")

        env = _build_runtime_env(self.workspace_root, agent_id)
        cmd = ["python3", "-m", "llm.cli.prompt", "-p", prompt]
        return await run_command(cmd, timeout=timeout, env=env)
