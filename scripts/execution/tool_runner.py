import asyncio
import logging
from dataclasses import dataclass
from typing import Dict, List, Optional
import subprocess

# Logging setup for local execution
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ToolRunner")

@dataclass
class ExecutionResult:
    stdout: str
    stderr: str
    returncode: int
    timed_out: bool = False

# Strict command allowlist
ALLOWED_COMMANDS = {
    "python": ["python3", "pytest"],
    "git": ["git"],
    "npm": ["npm", "yarn"]
}

async def run_command(cmd: List[str], timeout: int = 30, env: Optional[Dict[str, str]] = None) -> ExecutionResult:
    """Safely executes a command as a subprocess."""

    base_cmd = cmd[0]
    is_allowed = False
    for group in ALLOWED_COMMANDS.values():
        if base_cmd in group:
            is_allowed = True
            break

    if not is_allowed:
        logger.error(f"Command blocked: {base_cmd}")
        return ExecutionResult("", f"Command blocked: {base_cmd}", 1)

    logger.info(f"Executing: {' '.join(cmd)}")

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        return ExecutionResult(
            stdout.decode().strip(),
            stderr.decode().strip(),
            process.returncode
        )
    except asyncio.TimeoutError:
        process.terminate()
        return ExecutionResult("", "Command timed out", -1, timed_out=True)
    except Exception as e:
        return ExecutionResult("", str(e), 1)
