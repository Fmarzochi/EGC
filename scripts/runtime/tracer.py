import os
import json
import time
import logging
import threading
from typing import Dict, Any, Optional

logger = logging.getLogger("EGC.Tracer")

class TRACER:
    """
    EGC Execution Tracer
    Provides real-time, thread-safe tracing of orchestration events and failures.
    """

    def __init__(self, project_root: str = "."):
        self.project_root = project_root
        self.log_file = os.path.join(project_root, ".sessions", "execution_log.jsonl")
        os.makedirs(os.path.dirname(self.log_file), exist_ok=True)
        self.lock = threading.Lock()

    def trace_event(self, execution_id: str, event_type: str, data: Dict[str, Any]):
        """
        Logs a structured trace event safely across threads.
        """
        event = {
            "timestamp": time.time(),
            "execution_id": execution_id,
            "type": event_type,
            "data": data
        }
        
        with self.lock:
            try:
                with open(self.log_file, "a", encoding="utf-8") as f:
                    f.write(json.dumps(event) + "\n")
            except Exception:
                logger.exception("Failed to write trace event")

    def get_traces(self, execution_id: Optional[str] = None) -> list:
        """
        Reads traces from the log file.
        """
        traces = []
        if not os.path.exists(self.log_file):
            return traces
            
        with self.lock:
            try:
                with open(self.log_file, "r", encoding="utf-8") as f:
                    for line in f:
                        entry = json.loads(line)
                        if execution_id is None or entry.get("execution_id") == execution_id:
                            traces.append(entry)
            except Exception:
                logger.exception("Failed to read traces")
            
        return traces
