// Session Bus: presence, cooperative path locks, and an event queue for
// parallel sessions sharing one ~/.egc store. Presence and locks prevent
// duplicated work and state corruption; the event queue lets sessions talk
// to each other (direct or broadcast) through a durable pub/sub table, with
// a per-session read cursor so every session consumes each event once.

import { createRequire } from 'node:module';
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
    CREATE TABLE IF NOT EXISTS mesh_machines (
      machine_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      sessions TEXT NOT NULL,
      seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mesh_boxes (
      box_id TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mesh_locks (
      machine_id TEXT NOT NULL,
      project_key TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      ttl_seconds INTEGER NOT NULL,
      PRIMARY KEY (machine_id, project_key, relative_path)
    );
    CREATE TABLE IF NOT EXISTS mesh_inbound_events (
      event_id INTEGER PRIMARY KEY
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

// A box the bridge took from the mesh, by its id, kept for a day: true the
// first time, false for a repeat, so a bridge that restarts or replaces the
// one that took it refuses it the way the running one does.
export const BOX_MEMORY_SECONDS = 24 * 60 * 60;

export async function rememberBox(db: BusDb, boxId: string, nowMs: number = Date.now()): Promise<boolean> {
  const now = new Date(nowMs).toISOString();
  await db.run('DELETE FROM mesh_boxes WHERE seen_at < ?', new Date(nowMs - BOX_MEMORY_SECONDS * 1000).toISOString());
  const result = await db.run('INSERT OR IGNORE INTO mesh_boxes (box_id, seen_at) VALUES (?, ?)', boxId, now);
  return typeof (result as { changes?: number })?.changes === 'number' && (result as { changes: number }).changes > 0;
}

// Lazy GC: dead sessions release their presence and every lock they held.
// Clock skew is irrelevant because all timestamps come from this machine.
export async function sweepDead(db: BusDb, nowMs: number = Date.now()): Promise<void> {
  const cutoff = new Date(nowMs - SESSION_TTL_SECONDS * 1000).toISOString();
  await db.run('DELETE FROM bus_locks WHERE session_id IN (SELECT id FROM bus_sessions WHERE heartbeat_at < ?)', cutoff);
  await db.run('DELETE FROM bus_sessions WHERE heartbeat_at < ?', cutoff);
  await db.run(
    'DELETE FROM bus_locks WHERE (julianday(?) - julianday(acquired_at)) * 86400 > ttl_seconds',
    new Date(nowMs).toISOString()
  );
  const eventCutoff = new Date(nowMs - EVENT_TTL_SECONDS * 1000).toISOString();
  await db.run('DELETE FROM bus_events WHERE created_at < ?', eventCutoff);
  await db.run('DELETE FROM bus_event_cursors WHERE session_id NOT IN (SELECT id FROM bus_sessions)');
  await db.run('DELETE FROM mesh_inbound_events WHERE event_id NOT IN (SELECT id FROM bus_events)');
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

// The sessions of this machine and, after them, the sessions the other
// machines of the team reported through the mesh, each with the label of
// its machine. A project filter matches a remote session by the identity
// of its repository, since the same project sits in another folder there.
export async function listPeers(db: BusDb, projectPath?: string): Promise<Record<string, unknown>[]> {
  const local = projectPath
    ? await db.all('SELECT * FROM bus_sessions WHERE project_path = ? ORDER BY started_at', projectPath)
    : await db.all('SELECT * FROM bus_sessions ORDER BY started_at');
  return [...local, ...await listRemoteSessions(db, projectPath)];
}

// A session as the mesh carries it, with the identity of its project so
// another machine can match it against its own checkouts.
export interface RemoteSession {
  id: string;
  project_path: string | null;
  project_key: string | null;
  territory: string | null;
  started_at: string;
  heartbeat_at: string;
}

export const REMOTE_MACHINE_TTL_SECONDS = SESSION_TTL_SECONDS;
const MAX_REMOTE_SESSIONS = 50;

// The identity of a project (branch-state), loaded when first needed: the
// bus is also run on its own, by the test harnesses that copy this module
// alone, and there a session simply carries no project key.
type ProjectIdentityFn = (projectPath: string) => { key: string };
let projectIdentityFn: ProjectIdentityFn | null | undefined;

function projectKeyOf(projectPath: string | null): string | null {
  if (!projectPath) return null;
  if (projectIdentityFn === undefined) {
    try {
      const load = createRequire(__filename);
      projectIdentityFn = (load('./branch-state') as { projectIdentity: ProjectIdentityFn }).projectIdentity;
    } catch {
      projectIdentityFn = null;
    }
  }
  if (!projectIdentityFn) return null;
  try {
    return projectIdentityFn(projectPath).key;
  } catch {
    return null;
  }
}

// The sessions alive on this machine (heartbeat within the session TTL).
export async function listLiveSessions(db: BusDb, nowMs: number = Date.now()): Promise<RemoteSession[]> {
  const cutoff = new Date(nowMs - SESSION_TTL_SECONDS * 1000).toISOString();
  const rows = await db.all('SELECT id, project_path, territory, started_at, heartbeat_at FROM bus_sessions WHERE heartbeat_at >= ? ORDER BY started_at', cutoff);
  return rows.map(row => {
    const projectPath = row.project_path ? rowText(row.project_path) : null;
    return {
      id: rowText(row.id),
      project_path: projectPath,
      project_key: projectKeyOf(projectPath),
      territory: row.territory ? rowText(row.territory) : null,
      started_at: rowText(row.started_at),
      heartbeat_at: rowText(row.heartbeat_at),
    };
  });
}

// Only the fields the mesh defines, each cut to its size, go into the table:
// what another machine sends is data, never a trusted shape.
function cleanRemoteSession(value: unknown): RemoteSession | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const text = (field: unknown, max: number): string | null => (typeof field === 'string' && field ? field.slice(0, max) : null);
  const id = text(record.id, 200);
  if (!id) return null;
  return {
    id,
    project_path: text(record.project_path, 1000),
    project_key: text(record.project_key, 300),
    territory: text(record.territory, 500),
    started_at: text(record.started_at, 40) ?? '',
    heartbeat_at: text(record.heartbeat_at, 40) ?? '',
  };
}

export async function recordRemotePresence(db: BusDb, machineId: string, label: string, sessions: unknown[], nowMs: number = Date.now()): Promise<void> {
  const clean = sessions.map(cleanRemoteSession).filter((session): session is RemoteSession => session !== null).slice(0, MAX_REMOTE_SESSIONS);
  await db.run(
    `INSERT INTO mesh_machines (machine_id, label, sessions, seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(machine_id) DO UPDATE SET label = excluded.label, sessions = excluded.sessions, seen_at = excluded.seen_at`,
    machineId, label.slice(0, 64), JSON.stringify(clean), new Date(nowMs).toISOString()
  );
}

export async function forgetRemoteMachine(db: BusDb, machineId: string): Promise<void> {
  await db.run('DELETE FROM mesh_machines WHERE machine_id = ?', machineId);
}

export async function sweepRemoteMachines(db: BusDb, nowMs: number = Date.now()): Promise<void> {
  await db.run('DELETE FROM mesh_machines WHERE seen_at < ?', new Date(nowMs - REMOTE_MACHINE_TTL_SECONDS * 1000).toISOString());
}

function parseSessions(raw: unknown): unknown[] {
  try {
    const parsed: unknown = JSON.parse(rowText(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// An event as the mesh carries it: with the identity of its project, so the
// machine that receives it files it under its own checkout.
export interface SharedEvent {
  event_id: number;
  from_session: string;
  to_session: string | null;
  project_key: string | null;
  kind: string;
  payload: string;
  created_at: string;
}

// The events queued here since `afterId` that another machine should see: a
// broadcast, or a direct event for a session that is not on this machine.
// An event that came from another machine (its sender is a remote session)
// is never sent back out.
export async function listOutboundEvents(db: BusDb, afterId: number, sinceIso: string | null): Promise<{ lastId: number; events: SharedEvent[] }> {
  // An event that came in from another machine is marked as such when it is
  // filed, so it never goes out again, whatever became of the presence of
  // the machine it came from. Events older than `sinceIso` (what the bus held
  // before the bridge existed) stay on this machine.
  const rows = await db.all(
    `SELECT id, from_session, to_session, project_path, kind, payload, created_at FROM bus_events
     WHERE id > ? AND created_at >= ? AND id NOT IN (SELECT event_id FROM mesh_inbound_events) ORDER BY id LIMIT 200`,
    afterId, sinceIso ?? ''
  );
  if (rows.length === 0) return { lastId: afterId, events: [] };
  const localIds = new Set((await db.all('SELECT id FROM bus_sessions')).map(row => rowText(row.id)));
  const events: SharedEvent[] = [];
  for (const row of rows) {
    const from = rowText(row.from_session);
    const to = row.to_session ? rowText(row.to_session) : null;
    if (to !== null && localIds.has(to)) continue;
    events.push({
      event_id: Number(row.id),
      from_session: from,
      to_session: to,
      project_key: projectKeyOf(row.project_path ? rowText(row.project_path) : null),
      kind: rowText(row.kind),
      payload: rowText(row.payload),
      created_at: rowText(row.created_at),
    });
  }
  return { lastId: Number(rows.at(-1)?.id ?? afterId), events };
}

export async function latestEventId(db: BusDb): Promise<number> {
  const row = await db.get('SELECT MAX(id) AS id FROM bus_events');
  return Number(row?.id ?? 0) || 0;
}

function cleanSharedEvent(value: unknown): SharedEvent | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const text = (field: unknown, max: number): string | null => (typeof field === 'string' && field ? field.slice(0, max) : null);
  const from = text(record.from_session, 200);
  const kind = text(record.kind, 200);
  if (!from || !kind) return null;
  const payload = typeof record.payload === 'string' ? record.payload : '';
  if (Buffer.byteLength(payload, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) return null;
  return { event_id: Number(record.event_id) || 0, from_session: from, to_session: text(record.to_session, 200), project_key: text(record.project_key, 300), kind, payload, created_at: text(record.created_at, 40) ?? '' };
}

// Files an event another machine sent under this machine's checkout of its
// repository (a broadcast reaches every local session of that repository; a
// direct event reaches its session when it is here). An event for a
// repository this machine does not have, or for a session that is not here,
// is dropped: nobody would read it.
export async function recordInboundEvent(db: BusDb, value: unknown, nowMs: number = Date.now()): Promise<boolean> {
  const event = cleanSharedEvent(value);
  if (!event) return false;
  const sessions = await db.all('SELECT id, project_path FROM bus_sessions');
  const destinations = inboundDestinations(event, sessions);
  if (destinations === null) return false;
  const createdAt = new Date(nowMs).toISOString();
  await Promise.all(destinations.map(async projectPath => {
    const inserted = await db.run(
      `INSERT INTO bus_events (from_session, to_session, project_path, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      event.from_session, event.to_session, projectPath, event.kind, event.payload, createdAt
    );
    const eventId = (inserted as { lastID?: number })?.lastID;
    if (eventId) await db.run('INSERT OR IGNORE INTO mesh_inbound_events (event_id) VALUES (?)', eventId);
  }));
  return true;
}

// Where an event from another machine is filed here: under the project of
// its target session, or, for a broadcast, under every local checkout of the
// repository it names (the same repository may be open in two folders);
// a broadcast with no repository reaches every session. null when nobody
// here would read it.
function inboundDestinations(event: SharedEvent, sessions: Record<string, unknown>[]): Array<string | null> | null {
  if (event.to_session) return directDestination(event, sessions);
  if (!event.project_key) return [null];
  const checkouts = new Set<string>();
  for (const row of sessions) {
    const projectPath = row.project_path ? rowText(row.project_path) : '';
    if (projectPath && projectKeyOf(projectPath) === event.project_key) checkouts.add(projectPath);
  }
  return checkouts.size > 0 ? [...checkouts] : null;
}

// A direct event names its repository; the target session has to be in
// that repository, not merely carry the id the sender asked for.
function directDestination(event: SharedEvent, sessions: Record<string, unknown>[]): Array<string | null> | null {
  const target = sessions.find(row => rowText(row.id) === event.to_session);
  if (!target) return null;
  const targetPath = target.project_path ? rowText(target.project_path) : null;
  if (event.project_key && projectKeyOf(targetPath) !== event.project_key) return null;
  return [targetPath];
}

// The remote sessions as session_peers lists them: those of the machines
// seen within the TTL, each with its machine's id and label; with a project
// filter, those of the same repository identity.
export async function listRemoteSessions(db: BusDb, projectPath?: string, nowMs: number = Date.now()): Promise<Record<string, unknown>[]> {
  const cutoff = new Date(nowMs - REMOTE_MACHINE_TTL_SECONDS * 1000).toISOString();
  const machines = await db.all('SELECT machine_id, label, sessions FROM mesh_machines WHERE seen_at >= ? ORDER BY label', cutoff);
  const wanted = projectPath ? projectKeyOf(projectPath) : null;
  const rows: Record<string, unknown>[] = [];
  for (const machine of machines) {
    for (const session of parseSessions(machine.sessions).map(cleanRemoteSession)) {
      if (!session) continue;
      if (projectPath && (!wanted || session.project_key !== wanted)) continue;
      rows.push({ ...session, machine_id: rowText(machine.machine_id), machine_label: rowText(machine.label) });
    }
  }
  return rows;
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
    const holder = await db.get('SELECT id, territory FROM bus_sessions WHERE id = ?', row.session_id); // NOSONAR: sequential by design, one shared db handle; a stale-lock delete must not race a concurrent read of the same row
    if (holder) live.push({ ...row, territory: holder.territory });
    else await db.run('DELETE FROM bus_locks WHERE path = ? AND session_id = ?', held, row.session_id); // NOSONAR: see above
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
  // A path a session of another machine holds, in the same repository, is
  // refused the way a local one is: the lock reached here with that
  // machine's presence, and the refusal names the machine.
  const remote = held ? null : await remoteLockOn(db, project, key, nowMs);
  if (remote) return { ok: false, holder: remote.session_id, holderTerritory: remote.territory, reason: `held by ${remote.session_id} on ${remote.machine_label}` };
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

// The locks of this machine and, after them, the live locks of the other
// machines of the team, each with the label of its machine and the path
// relative to its project.
export async function listLocks(db: BusDb, nowMs: number = Date.now()): Promise<Record<string, unknown>[]> {
  const local = await db.all('SELECT * FROM bus_locks ORDER BY acquired_at');
  const remote = await liveRemoteLocks(db, nowMs);
  return [...local, ...remote.map(lock => ({ path: lock.relative_path, session_id: lock.session_id, acquired_at: lock.acquired_at, ttl_seconds: lock.ttl_seconds, machine_id: lock.machine_id, machine_label: lock.machine_label, project_key: lock.project_key }))];
}

// A lock as the mesh carries it: the repository it belongs to and the path
// relative to the project, so another machine compares it against its own
// checkout of that repository.
export interface SharedLock {
  project_key: string;
  relative_path: string;
  session_id: string;
  acquired_at: string;
  ttl_seconds: number;
}

interface RemoteLockRow extends SharedLock { machine_id: string; machine_label: string }

function relativeLockPath(project: string, key: string): string | null {
  if (!project) return null;
  const relative = path.relative(claimKeyOf('', project), key);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

// The locks of this machine that another machine can relate to: those on a
// path inside a project with a repository identity.
export async function listSharedLocks(db: BusDb, nowMs: number = Date.now()): Promise<SharedLock[]> {
  // A lock of a session that fell silent is not the machine's to tell: the
  // sweep removes it here, and the other machines stop refusing it with the
  // next word from this one.
  const liveSince = new Date(nowMs - SESSION_TTL_SECONDS * 1000).toISOString();
  const rows = await db.all(
    `SELECT l.path, l.session_id, l.acquired_at, l.ttl_seconds, s.project_path FROM bus_locks l
     JOIN bus_sessions s ON s.id = l.session_id WHERE s.heartbeat_at >= ? ORDER BY l.acquired_at`,
    liveSince
  );
  const shared: SharedLock[] = [];
  for (const row of rows) {
    const acquired = Date.parse(rowText(row.acquired_at));
    if (Number.isFinite(acquired) && acquired + Number(row.ttl_seconds) * 1000 < nowMs) continue;
    const project = row.project_path ? rowText(row.project_path) : '';
    const projectKey = projectKeyOf(project || null);
    const relative = relativeLockPath(project, rowText(row.path));
    if (!projectKey || relative === null) continue;
    shared.push({ project_key: projectKey, relative_path: relative, session_id: rowText(row.session_id), acquired_at: rowText(row.acquired_at), ttl_seconds: Number(row.ttl_seconds) });
  }
  return shared;
}

function cleanSharedLock(value: unknown): SharedLock | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const text = (field: unknown, max: number): string | null => (typeof field === 'string' && field ? field.slice(0, max) : null);
  const projectKey = text(record.project_key, 300);
  const relative = text(record.relative_path, 1000);
  const sessionId = text(record.session_id, 200);
  const acquiredAt = text(record.acquired_at, 40);
  const ttl = Number(record.ttl_seconds);
  if (!projectKey || !relative || !sessionId || !acquiredAt || !Number.isFinite(ttl)) return null;
  return { project_key: projectKey, relative_path: relative, session_id: sessionId, acquired_at: acquiredAt, ttl_seconds: Math.min(Math.max(Math.trunc(ttl), 1), MAX_LOCK_TTL_SECONDS) };
}

// One transaction over the bus for what must land whole or not at all: the
// snapshot of another machine's locks, a box taken and what it said. SQLite
// has no nested transactions, so the callers do not open their own inside.
export async function withBusTransaction<T>(db: BusDb, work: () => Promise<T>): Promise<T> {
  // Transaction control goes through exec: the portable adapter tracks the
  // transaction there, and holds it until the commit.
  await db.exec('BEGIN IMMEDIATE');
  try {
    const result = await work();
    await db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.exec('ROLLBACK');
    } catch {
      // the transaction is gone already
    }
    throw error;
  }
}

// What a machine says it holds replaces what it said before, every lock of
// it: a lock it released is gone with the next word from it. The caller
// runs this inside withBusTransaction, so no claim lands between the old
// snapshot and the new one.
export async function recordRemoteLocks(db: BusDb, machineId: string, locks: unknown[]): Promise<void> {
  const clean = locks.map(cleanSharedLock).filter((lock): lock is SharedLock => lock !== null);
  await db.run('DELETE FROM mesh_locks WHERE machine_id = ?', machineId);
  await Promise.all(clean.map(lock => db.run(
    `INSERT OR REPLACE INTO mesh_locks (machine_id, project_key, relative_path, session_id, acquired_at, ttl_seconds) VALUES (?, ?, ?, ?, ?, ?)`,
    machineId, lock.project_key, lock.relative_path, lock.session_id, lock.acquired_at, lock.ttl_seconds
  )));
}

async function liveRemoteLocks(db: BusDb, nowMs: number): Promise<RemoteLockRow[]> {
  const cutoff = new Date(nowMs - REMOTE_MACHINE_TTL_SECONDS * 1000).toISOString();
  const rows = await db.all(
    `SELECT l.machine_id, m.label, l.project_key, l.relative_path, l.session_id, l.acquired_at, l.ttl_seconds FROM mesh_locks l
     JOIN mesh_machines m ON m.machine_id = l.machine_id WHERE m.seen_at >= ? ORDER BY l.acquired_at`,
    cutoff
  );
  return rows
    .filter(row => {
      const acquired = Date.parse(rowText(row.acquired_at));
      return !Number.isFinite(acquired) || acquired + Number(row.ttl_seconds) * 1000 >= nowMs;
    })
    .map(row => ({ machine_id: rowText(row.machine_id), machine_label: rowText(row.label), project_key: rowText(row.project_key), relative_path: rowText(row.relative_path), session_id: rowText(row.session_id), acquired_at: rowText(row.acquired_at), ttl_seconds: Number(row.ttl_seconds) }));
}

function overlapsRelative(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// The lock a session of another machine holds on this path (or on a path
// above or below it) in the same repository, or null.
async function remoteLockOn(db: BusDb, project: string, key: string, nowMs: number): Promise<{ session_id: string; machine_label: string; territory?: string } | null> {
  const projectKey = projectKeyOf(project || null);
  const relative = relativeLockPath(project, key);
  if (!projectKey || relative === null) return null;
  const match = (await liveRemoteLocks(db, nowMs)).find(lock => lock.project_key === projectKey && overlapsRelative(lock.relative_path, relative));
  if (!match) return null;
  const session = (await listRemoteSessions(db, undefined, nowMs)).find(row => row.id === match.session_id && row.machine_id === match.machine_id);
  return { session_id: match.session_id, machine_label: match.machine_label, territory: session?.territory ? rowText(session.territory) : undefined };
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
      // A session of another machine, in the same repository, is reached
      // through the bridge, which forwards what is queued for it here.
      const remote = (await listRemoteSessions(db, input.projectPath, nowMs)).find(row => row.id === input.toSession);
      if (!remote) return { ok: false, reason: `session ${input.toSession} is not live on the bus` };
    } else if ((target.project_path ?? null) !== (input.projectPath ?? null)) {
      // A direct event stays inside the sender's project, like a broadcast;
      // a sender without a project only reaches a session without one.
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
