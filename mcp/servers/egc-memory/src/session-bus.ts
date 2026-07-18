// Session Bus MVP: presence and cooperative path locks for parallel sessions
// sharing one ~/.egc store. This is the minimum that prevents duplicated work
// and state corruption; messaging and guardian enforcement build on top later.

export interface BusDb {
  run(sql: string, ...params: unknown[]): Promise<unknown>;
  get(sql: string, ...params: unknown[]): Promise<Record<string, unknown> | undefined>;
  all(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]>;
  exec(sql: string): Promise<unknown>;
}

export const SESSION_TTL_SECONDS = 600;
export const DEFAULT_LOCK_TTL_SECONDS = 900;
export const MAX_LOCK_TTL_SECONDS = 3600;

export async function createSessionBusTables(db: BusDb): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS bus_sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT,
      territory TEXT,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bus_locks (
      path TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      ttl_seconds INTEGER NOT NULL
    );
  `);
}

// Lazy GC: dead sessions release their presence and every lock they held.
// Clock skew is irrelevant because all timestamps come from this machine.
export async function sweepDead(db: BusDb, nowMs: number = Date.now()): Promise<void> {
  const cutoff = new Date(nowMs - SESSION_TTL_SECONDS * 1000).toISOString();
  await db.run('DELETE FROM bus_locks WHERE session_id IN (SELECT id FROM bus_sessions WHERE heartbeat_at < ?)', cutoff);
  await db.run('DELETE FROM bus_sessions WHERE heartbeat_at < ?', cutoff);
  await db.run(
    "DELETE FROM bus_locks WHERE (julianday('now') - julianday(acquired_at)) * 86400 > ttl_seconds"
  );
}

export async function announce(
  db: BusDb,
  input: { sessionId: string; projectPath?: string; territory?: string },
  nowMs: number = Date.now()
): Promise<void> {
  const now = new Date(nowMs).toISOString();
  await db.run(
    `INSERT INTO bus_sessions (id, project_path, territory, started_at, heartbeat_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_path = excluded.project_path,
       territory = COALESCE(excluded.territory, bus_sessions.territory),
       heartbeat_at = excluded.heartbeat_at`,
    input.sessionId, input.projectPath || null, input.territory || null, now, now
  );
}

export async function listPeers(db: BusDb, projectPath?: string): Promise<Record<string, unknown>[]> {
  if (projectPath) {
    return db.all('SELECT * FROM bus_sessions WHERE project_path = ? ORDER BY started_at', projectPath);
  }
  return db.all('SELECT * FROM bus_sessions ORDER BY started_at');
}

export interface ClaimResult {
  ok: boolean;
  holder?: string;
  holderTerritory?: string;
}

// Fail-fast claim: a conflicting live lock is reported, never queued.
export async function claimPath(
  db: BusDb,
  input: { sessionId: string; path: string; ttlSeconds?: number },
  nowMs: number = Date.now()
): Promise<ClaimResult> {
  const ttl = Math.min(Math.max(input.ttlSeconds || DEFAULT_LOCK_TTL_SECONDS, 1), MAX_LOCK_TTL_SECONDS);
  const existing = await db.get('SELECT session_id FROM bus_locks WHERE path = ?', input.path);
  if (existing && existing.session_id !== input.sessionId) {
    const holder = await db.get('SELECT id, territory FROM bus_sessions WHERE id = ?', existing.session_id);
    if (holder) {
      return { ok: false, holder: String(holder.id), holderTerritory: holder.territory ? String(holder.territory) : undefined };
    }
    await db.run('DELETE FROM bus_locks WHERE path = ?', input.path);
  }
  await db.run(
    `INSERT INTO bus_locks (path, session_id, acquired_at, ttl_seconds)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       session_id = excluded.session_id,
       acquired_at = excluded.acquired_at,
       ttl_seconds = excluded.ttl_seconds`,
    input.path, input.sessionId, new Date(nowMs).toISOString(), ttl
  );
  return { ok: true };
}

export async function releasePath(db: BusDb, input: { sessionId: string; path: string }): Promise<boolean> {
  const existing = await db.get('SELECT session_id FROM bus_locks WHERE path = ?', input.path);
  if (!existing || existing.session_id !== input.sessionId) return false;
  await db.run('DELETE FROM bus_locks WHERE path = ?', input.path);
  return true;
}

export async function listLocks(db: BusDb): Promise<Record<string, unknown>[]> {
  return db.all('SELECT * FROM bus_locks ORDER BY acquired_at');
}
