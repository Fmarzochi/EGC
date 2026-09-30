import sqlite3
import json
import asyncio
import os
import uuid
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

# The CLI state store has one home, <EGC dir>/egc/state.db: ~/.egc by
# default, EGC_DIR when set (scripts/lib/state-store/path.js keeps the same
# rule for the Node side).
_STATE_DB_RELATIVE = os.path.join('.egc', 'egc', 'state.db')

def _resolve_state_db_path() -> str:
    egc_dir = os.environ.get('EGC_DIR')
    if egc_dir:
        return os.path.join(egc_dir, 'egc', 'state.db')
    home = os.environ.get('HOME') or os.path.expanduser('~')
    return os.path.join(home, _STATE_DB_RELATIVE)

def _confidence_for_status(status: str) -> float:
    return 0.8 if str(status).lower() in ('success', 'ok', 'completed') else 0.3

def _tee_instinct_to_state_db(task_hash: str, agent_id: str, status: str, data: Dict[str, Any]) -> None:
    db_path = _resolve_state_db_path()
    if not os.path.exists(db_path):
        return
    try:
        content = json.dumps(data) if not isinstance(data, str) else data
        now = datetime.now(timezone.utc).isoformat()
        instinct_id = str(uuid.uuid4())
        with sqlite3.connect(db_path, timeout=2.0) as conn:
            conn.execute(
                """INSERT INTO instincts (id, project_id, trigger, content, confidence, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, NULL)
                   ON CONFLICT(id) DO NOTHING""",
                (instinct_id, agent_id or 'unknown', task_hash, content,
                 _confidence_for_status(status), now)
            )
    except Exception:
        pass

class PersistentMemory:
    def __init__(self, db_path: str = ".sessions/memory/egc_memory.db"):
        self.db_path = db_path
        self.lock = asyncio.Lock()
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS experiences (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_hash TEXT,
                    agent_id TEXT,
                    result_status TEXT,
                    data TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            """)

    async def store_experience(self, task_hash: str, agent_id: str, status: str, data: Dict[str, Any]):
        async with self.lock:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute(
                    "INSERT INTO experiences (task_hash, agent_id, result_status, data) VALUES (?, ?, ?, ?)",
                    (task_hash, agent_id, status, json.dumps(data))
                )
        _tee_instinct_to_state_db(task_hash, agent_id, status, data)

    async def recall_similar(self, task_hash: str) -> List[Dict[str, Any]]:
        async with self.lock:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.execute(
                    "SELECT data FROM experiences WHERE task_hash = ? ORDER BY timestamp DESC LIMIT 5",
                    (task_hash,)
                )
                return [json.loads(row[0]) for row in cursor.fetchall()]
