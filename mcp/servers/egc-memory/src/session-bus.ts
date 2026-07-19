// Session Bus: presence, cooperative path locks, and an event queue for
// parallel sessions sharing one ~/.egc store. Presence and locks prevent
// duplicated work and state corruption; the event queue lets sessions talk
// to each other (direct or broadcast) through a durable pub/sub table, with
// a per-session read cursor so every session consumes each event once.

export interface BusDb {
  run(sql: string, ...params: unknown[]): Promise<unknown>;
  get(sql: string, ...params: unknown[]): Promise<Record<string, unknown> | undefined>;
  all(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]>;
  exec(sql: string): Promise<unknown>;
}

export const SESSION_TTL_SECONDS = 600;
export const DEFAULT_LOCK_TTL_SECONDS = 900;
export const MAX_LOCK_TTL_SECONDS = 3600;
export const EVENT_TTL_SECONDS = 24 * 60 * 60;
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;
export const MAX_EVENTS_PER_READ = 50;
export const MAX_PENDING_EVENTS_PER_SENDER = 200;

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
    CREATE TABLE IF NOT EXISTS bus_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_session TEXT NOT NULL,
      to_session TEXT,
      project_path TEXT,
      kind TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bus_events_target
      ON bus_events (to_session, id);
    CREATE TABLE IF NOT EXISTS bus_event_cursors (
      session_id TEXT PRIMARY KEY,
      last_event_id INTEGER NOT NULL
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
  const eventCutoff = new Date(nowMs - EVENT_TTL_SECONDS * 1000).toISOString();
  await db.run('DELETE FROM bus_events WHERE created_at < ?', eventCutoff);
  await db.run('DELETE FROM bus_event_cursors WHERE session_id NOT IN (SELECT id FROM bus_sessions)');
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
  // A session subscribes from the moment it joins: the cursor starts at the
  // current top of the queue, so a newcomer (or a session reconnecting after
  // its cursor was swept) never replays up to 24h of old events.
  await db.run(
    `INSERT OR IGNORE INTO bus_event_cursors (session_id, last_event_id)
     VALUES (?, COALESCE((SELECT MAX(id) FROM bus_events), 0))`,
    input.sessionId
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
// Every acquisition path is a conditional write (INSERT OR IGNORE or a
// session-guarded UPDATE/DELETE), so two concurrent claimers can never both
// win: whoever lands the row first owns it and the loser sees changes === 0.
export async function claimPath(
  db: BusDb,
  input: { sessionId: string; path: string; ttlSeconds?: number },
  nowMs: number = Date.now()
): Promise<ClaimResult> {
  const ttl = Math.min(Math.max(input.ttlSeconds || DEFAULT_LOCK_TTL_SECONDS, 1), MAX_LOCK_TTL_SECONDS);
  const now = new Date(nowMs).toISOString();

  const changed = (result: unknown): boolean =>
    typeof (result as { changes?: number })?.changes === 'number'
    && (result as { changes: number }).changes > 0;

  const refresh = await db.run(
    'UPDATE bus_locks SET acquired_at = ?, ttl_seconds = ? WHERE path = ? AND session_id = ?',
    now, ttl, input.path, input.sessionId
  );
  if (changed(refresh)) return { ok: true };

  const tryInsert = () => db.run(
    'INSERT OR IGNORE INTO bus_locks (path, session_id, acquired_at, ttl_seconds) VALUES (?, ?, ?, ?)',
    input.path, input.sessionId, now, ttl
  );
  if (changed(await tryInsert())) return { ok: true };

  const existing = await db.get('SELECT session_id FROM bus_locks WHERE path = ?', input.path);
  if (!existing) {
    return changed(await tryInsert())
      ? { ok: true }
      : { ok: false };
  }

  const holder = await db.get('SELECT id, territory FROM bus_sessions WHERE id = ?', existing.session_id);
  if (!holder) {
    await db.run(
      'DELETE FROM bus_locks WHERE path = ? AND session_id = ?',
      input.path, existing.session_id
    );
    if (changed(await tryInsert())) return { ok: true };
    const winner = await db.get('SELECT session_id FROM bus_locks WHERE path = ?', input.path);
    return { ok: false, holder: winner ? String(winner.session_id) : undefined };
  }

  return { ok: false, holder: String(holder.id), holderTerritory: holder.territory ? String(holder.territory) : undefined };
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

export interface SendResult {
  ok: boolean;
  eventId?: number;
  reason?: string;
}

// Durable pub/sub: a null toSession means broadcast to every session in the
// project. Payloads are size-capped so the queue never becomes a byte sink;
// large context belongs in the state files, events carry pointers and intents.
export async function sendEvent(
  db: BusDb,
  input: { fromSession: string; toSession?: string; projectPath?: string; kind: string; payload?: string },
  nowMs: number = Date.now()
): Promise<SendResult> {
  const payload = input.payload || '';
  if (Buffer.byteLength(payload, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
    return { ok: false, reason: `payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes; store the content in project state and send a pointer instead` };
  }
  // Flood guard: a runaway sender cannot grow the queue without bound.
  const pending = await db.get(
    'SELECT COUNT(*) AS n FROM bus_events WHERE from_session = ?',
    input.fromSession
  );
  if (pending && Number(pending.n) >= MAX_PENDING_EVENTS_PER_SENDER) {
    return { ok: false, reason: `sender has ${MAX_PENDING_EVENTS_PER_SENDER} unexpired events on the bus; wait for the sweep or slow down` };
  }
  if (input.toSession) {
    const target = await db.get('SELECT id FROM bus_sessions WHERE id = ?', input.toSession);
    if (!target) {
      return { ok: false, reason: `session ${input.toSession} is not live on the bus` };
    }
  }
  const result = await db.run(
    `INSERT INTO bus_events (from_session, to_session, project_path, kind, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.fromSession, input.toSession || null, input.projectPath || null,
    input.kind, payload, new Date(nowMs).toISOString()
  );
  const eventId = (result as { lastID?: number })?.lastID;
  return { ok: true, eventId };
}

// Cursor-based read: each session sees every event addressed to it (direct or
// broadcast, excluding its own) exactly once across calls, oldest first.
// Exactly-once holds per session id within one server process; two processes
// sharing the same session id degrade to at-least-once, since the cursor
// update happens after the select.
export async function readEvents(
  db: BusDb,
  input: { sessionId: string; projectPath?: string; peek?: boolean }
): Promise<Record<string, unknown>[]> {
  const cursor = await db.get('SELECT last_event_id FROM bus_event_cursors WHERE session_id = ?', input.sessionId);
  const after = cursor ? Number(cursor.last_event_id) : 0;
  const params: unknown[] = [after, input.sessionId, input.sessionId];
  let projectFilter = '';
  if (input.projectPath) {
    projectFilter = ' AND (project_path IS NULL OR project_path = ?)';
    params.push(input.projectPath);
  }
  const events = await db.all(
    `SELECT id, from_session, to_session, project_path, kind, payload, created_at
     FROM bus_events
     WHERE id > ? AND from_session != ?
       AND (to_session IS NULL OR to_session = ?)${projectFilter}
     ORDER BY id ASC
     LIMIT ${MAX_EVENTS_PER_READ}`,
    ...params
  );
  if (events.length > 0 && !input.peek) {
    const maxId = Number(events[events.length - 1].id);
    await db.run(
      `INSERT INTO bus_event_cursors (session_id, last_event_id) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_event_id = excluded.last_event_id
       WHERE excluded.last_event_id > bus_event_cursors.last_event_id`,
      input.sessionId, maxId
    );
  }
  return events;
}
