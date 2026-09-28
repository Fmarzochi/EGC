// Session Bus: presence, cooperative path locks, and an event queue for
// parallel sessions sharing one ~/.egc store. Presence and locks prevent
// duplicated work and state corruption; the event queue lets sessions talk
// to each other (direct or broadcast) through a durable pub/sub table, with
// a per-session read cursor so every session consumes each event once.

import path from 'node:path';

// Text form of a column read from a bus row: rows arrive as loosely typed
// records, so a value is rendered explicitly instead of relying on the
// default object stringification.
export function rowText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return value === null || value === undefined ? '' : JSON.stringify(value);
}

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
  reason?: string;
}

// The key a claim is held under: the path it names, resolved against the
// project of the session that claims it (the same words in another project
// are another file), normalized, with no trailing separator.
// Windows and a default macOS disk name one file in any case, so a key is
// kept in one case there.
export function claimKeyOf(project: string, claimed: string, platform: string = process.platform): string {
  const key = project ? path.resolve(project, claimed) : path.resolve(claimed);
  return platform === 'win32' || platform === 'darwin' ? key.toLowerCase() : key;
}

async function sessionProject(db: BusDb, sessionId: string): Promise<string> {
  const session = await db.get('SELECT project_path FROM bus_sessions WHERE id = ?', sessionId);
  return session?.project_path ? rowText(session.project_path) : '';
}

async function claimKey(db: BusDb, sessionId: string, claimed: string): Promise<string> {
  return claimKeyOf(await sessionProject(db, sessionId), claimed);
}

// A claim of the file system's root, or of a directory above the project,
// would lock every project under it: it is refused.
function tooWideClaim(key: string, projectKey: string): string | null {
  if (key === path.parse(key).root) return `${key} is the root of the file system`;
  if (projectKey && isInside(projectKey, key)) return `${key} holds the whole project, and every project beside it`;
  return null;
}

// Whether two claim keys cover a common file: the same path, or one inside
// the other.
export function claimsOverlap(a: string, b: string): boolean {
  return a === b || isInside(a, b) || isInside(b, a);
}

// Whether the key `inner` lies under the key `outer`.
function isInside(inner: string, outer: string): boolean {
  return inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
}

// The live foreign locks above or inside `key` (not on it: that path has its
// own handling), a stale one removed on the way.
async function overlappingLocks(db: BusDb, key: string, sessionId: string): Promise<Record<string, unknown>[]> {
  const rows = await db.all('SELECT path, session_id, acquired_at FROM bus_locks WHERE session_id != ?', sessionId);
  const live: Record<string, unknown>[] = [];
  for (const row of rows) {
    const held = rowText(row.path);
    if (held === key || !claimsOverlap(held, key)) continue;
    const holder = await db.get('SELECT id, territory FROM bus_sessions WHERE id = ?', row.session_id);
    if (holder) live.push({ ...row, territory: holder.territory });
    else await db.run('DELETE FROM bus_locks WHERE path = ? AND session_id = ?', held, row.session_id);
  }
  return live;
}

const refusedBy = (row: Record<string, unknown>): ClaimResult => ({
  ok: false,
  holder: rowText(row.session_id),
  holderTerritory: row.territory ? rowText(row.territory) : undefined,
});

// A claim that landed at the same time as an overlapping one from another
// session: the later of the two (by acquisition time, then session id)
// yields its row, so exactly one of them holds the tree.
async function yieldToEarlierOverlap(db: BusDb, key: string, sessionId: string): Promise<ClaimResult> {
  const mine = await db.get('SELECT acquired_at FROM bus_locks WHERE path = ? AND session_id = ?', key, sessionId);
  const mineAt = rowText(mine?.acquired_at);
  const earlier = (await overlappingLocks(db, key, sessionId)).find(row => {
    const theirs = rowText(row.acquired_at);
    return theirs < mineAt || (theirs === mineAt && rowText(row.session_id) < sessionId);
  });
  if (!earlier) return { ok: true };
  await db.run('DELETE FROM bus_locks WHERE path = ? AND session_id = ?', key, sessionId);
  return refusedBy(earlier);
}

// Fail-fast claim: a conflicting live lock is reported, never queued. A
// claim covers the tree under its path, so a live lock above or inside it
// refuses it too.
export async function claimPath(
  db: BusDb,
  input: { sessionId: string; path: string; ttlSeconds?: number },
  nowMs: number = Date.now()
): Promise<ClaimResult> {
  const project = await sessionProject(db, input.sessionId);
  const key = claimKeyOf(project, input.path);
  const tooWide = tooWideClaim(key, project ? claimKeyOf('', project) : '');
  if (tooWide) return { ok: false, reason: `${tooWide}; claim a path inside the project` };
  const blocking = await overlappingLocks(db, key, input.sessionId);
  // A session already holding the path when an overlapping lock appeared
  // renews it, and the order of the two decides which one stays.
  const held = await db.get('SELECT session_id FROM bus_locks WHERE path = ? AND session_id = ?', key, input.sessionId);
  if (blocking.length > 0 && !held) return refusedBy(blocking[0]);
  const claimed = await claimExactPath(db, { ...input, path: key }, nowMs);
  return claimed.ok ? yieldToEarlierOverlap(db, key, input.sessionId) : claimed;
}

// Every acquisition path is a conditional write (INSERT OR IGNORE or a
// session-guarded UPDATE/DELETE), so two concurrent claimers of the same
// path can never both win: whoever lands the row first owns it and the
// loser sees changes === 0.
async function claimExactPath(
  db: BusDb,
  input: { sessionId: string; path: string; ttlSeconds?: number },
  nowMs: number
): Promise<ClaimResult> {
  const ttl = Math.min(Math.max(input.ttlSeconds || DEFAULT_LOCK_TTL_SECONDS, 1), MAX_LOCK_TTL_SECONDS);
  const now = new Date(nowMs).toISOString();

  const changed = (result: unknown): boolean =>
    typeof (result as { changes?: number })?.changes === 'number'
    && (result as { changes: number }).changes > 0;

  // A renewal keeps the time the lock was first taken, which orders
  // overlapping claims, and extends its lifetime to `ttl` from now.
  const refresh = await db.run(
    'UPDATE bus_locks SET ttl_seconds = CAST(ROUND((julianday(?) - julianday(acquired_at)) * 86400) AS INTEGER) + ? WHERE path = ? AND session_id = ?',
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
    return { ok: false, holder: winner ? rowText(winner.session_id) : undefined };
  }

  return { ok: false, holder: rowText(holder.id), holderTerritory: holder.territory ? rowText(holder.territory) : undefined };
}

export async function releasePath(db: BusDb, input: { sessionId: string; path: string }): Promise<boolean> {
  const key = await claimKey(db, input.sessionId, input.path);
  const existing = await db.get('SELECT session_id FROM bus_locks WHERE path = ?', key);
  if (existing?.session_id !== input.sessionId) return false;
  await db.run('DELETE FROM bus_locks WHERE path = ?', key);
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
    const target = await db.get('SELECT id, project_path FROM bus_sessions WHERE id = ?', input.toSession);
    if (!target) {
      return { ok: false, reason: `session ${input.toSession} is not live on the bus` };
    }
    // A direct event stays inside the sender's project, like a broadcast;
    // a sender without a project only reaches a session without one.
    if ((target.project_path ?? null) !== (input.projectPath ?? null)) {
      return { ok: false, reason: `session ${input.toSession} is not live in this project` };
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
// broadcast, excluding its own) exactly once across calls and processes that
// share the same session id, oldest first. Readers optimistically select from
// the same cursor snapshot, then compare-and-swap the cursor. Only the reader
// that advances the expected cursor may deliver that batch; a loser discards
// its stale snapshot so overlapping readers cannot duplicate delivery.
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
  if (events.length === 0 || input.peek) return events;

  const maxId = Number(events.at(-1)?.id);
  const claim = cursor
    ? await db.run(
      `UPDATE bus_event_cursors
       SET last_event_id = ?
       WHERE session_id = ? AND last_event_id = ?`,
      maxId, input.sessionId, after
    )
    : await db.run(
      `INSERT OR IGNORE INTO bus_event_cursors (session_id, last_event_id)
       VALUES (?, ?)`,
      input.sessionId, maxId
    );
  const claimed = typeof (claim as { changes?: number })?.changes === 'number'
    && (claim as { changes: number }).changes > 0;

  return claimed ? events : [];
}
