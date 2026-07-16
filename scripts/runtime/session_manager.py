import os
import json
import time
import uuid
import logging
import threading
from typing import Dict, Any, Optional, List

logger = logging.getLogger("EGC.SessionManager")

class SESSION_MANAGER:
    """
    EGC Session Manager
    Handles the lifecycle, state, and history of EGC execution sessions with thread safety.
    """

    def __init__(self, project_root: str = "."):
        self.project_root = project_root
        self.sessions_dir = os.path.join(project_root, ".sessions")
        os.makedirs(self.sessions_dir, exist_ok=True)
        self.current_session_id = str(uuid.uuid4())
        self.session_file = os.path.join(self.sessions_dir, f"session_{self.current_session_id}.json")
        self.state = {
            "session_id": self.current_session_id,
            "start_time": time.time(),
            "status": "active",
            "tasks": [],
            "metadata": {}
        }
        self.lock = threading.Lock()
        self._save_session()

    def start_task(self, task_description: str) -> str:
        task_id = str(uuid.uuid4())
        task_entry = {
            "task_id": task_id,
            "description": task_description,
            "start_time": time.time(),
            "status": "running",
            "events": []
        }
        with self.lock:
            self.state["tasks"].append(task_entry)
            self._save_session()
        logger.info(f"Task started: {task_id}")
        return task_id

    def update_task(self, task_id: str, status: str, event: Optional[str] = None):
        with self.lock:
            for task in self.state["tasks"]:
                if task["task_id"] == task_id:
                    task["status"] = status
                    if event:
                        task["events"].append({
                            "timestamp": time.time(),
                            "event": event
                        })
                    break
            self._save_session()

    def end_task(self, task_id: str, result: Dict[str, Any]):
        with self.lock:
            for task in self.state["tasks"]:
                if task["task_id"] == task_id:
                    task["status"] = "completed"
                    task["end_time"] = time.time()
                    task["result"] = result
                    break
            self._save_session()
        logger.info(f"Task ended: {task_id}")

    def _save_session(self):
        try:
            with open(self.session_file, "w", encoding="utf-8") as f:
                json.dump(self.state, f, indent=2)
        except Exception:
            logger.exception("Failed to save session state")

    def close_session(self):
        with self.lock:
            self.state["status"] = "closed"
            self.state["end_time"] = time.time()
            self._save_session()
        logger.info(f"Session closed: {self.current_session_id}")
