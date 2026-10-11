import type { Database } from 'sqlite';
import { randomUUID } from 'node:crypto';

// TTL used when the caller does not supply one: one calendar day in seconds.
// Entries without an explicit TTL are swept by the next get_state or working
// memory read of a later session, so they function as session-scoped scratch
// storage.
export const SESSION_TTL_SECONDS = 86400;

export interface WorkingMemoryEntry {
  id: string;
  project_path: string;
  key: string;
  value: string;
  expires_at: number;
}

export async function createWorkingMemoryTable(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS working_memory (
      id          TEXT    PRIMARY KEY,
      project_path TEXT   NOT NULL,
      key         TEXT    NOT NULL,
      value       TEXT    NOT NULL,
      expires_at  INTEGER NOT NULL,
      UNIQUE (project_path, key)
    );
  `);
  await createWorkingMemoryExpiryIndex(db);
}

// The sweep every read runs looks rows up by expiry, so the column is indexed.
export async function createWorkingMemoryExpiryIndex(db: Database): Promise<void> {
  await db.exec('CREATE INDEX IF NOT EXISTS idx_working_memory_expires_at ON working_memory (expires_at);');
}

// Remove all entries whose expiry timestamp is in the past.
// Called from get_state and from every working memory read, so a session that
// never calls get_state does not keep its expired entries around.
export async function sweepExpired(db: Database): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.run(
    'DELETE FROM working_memory WHERE expires_at <= ?',
    [now]
  );
  return result.changes ?? 0;
}

// The sweep a read runs. It is skipped when nothing has expired, so the common
// case stays a pure read (a write makes the portable engine rewrite the whole
// file), and it is never fatal, since the expires_at filter of the read already
// leaves expired rows out: a sweep that meets another writer's lock is left to
// the next read or to get_state.
async function sweepExpiredOnRead(db: Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expired = await db.get('SELECT 1 FROM working_memory WHERE expires_at <= ? LIMIT 1', [now]);
  if (!expired) return;
  try {
    await sweepExpired(db);
  } catch (error) {
    console.error('[EGC memory] working memory sweep on read failed, reading without it:', String(error));
  }
}

export async function setWorkingMemory(
  db: Database,
  projectPath: string,
  key: string,
  value: string,
  ttlSeconds?: number
): Promise<void> {
  const ttl = (ttlSeconds !== undefined && ttlSeconds > 0)
    ? ttlSeconds
    : SESSION_TTL_SECONDS;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const id = randomUUID();

  // Upsert: replace any existing entry for the same project+key.
  await db.run(
    `INSERT INTO working_memory (id, project_path, key, value, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_path, key) DO UPDATE SET
       id         = excluded.id,
       value      = excluded.value,
       expires_at = excluded.expires_at`,
    [id, projectPath, key, value, expiresAt]
  );
}

export async function getWorkingMemory(
  db: Database,
  projectPath: string,
  key: string
): Promise<WorkingMemoryEntry | null> {
  await sweepExpiredOnRead(db);
  const now = Math.floor(Date.now() / 1000);
  const row = await db.get<WorkingMemoryEntry>(
    'SELECT * FROM working_memory WHERE project_path = ? AND key = ? AND expires_at > ?',
    [projectPath, key, now]
  );
  return row ?? null;
}

export async function listWorkingMemory(
  db: Database,
  projectPath: string
): Promise<WorkingMemoryEntry[]> {
  await sweepExpiredOnRead(db);
  const now = Math.floor(Date.now() / 1000);
  return db.all<WorkingMemoryEntry[]>(
    'SELECT * FROM working_memory WHERE project_path = ? AND expires_at > ? ORDER BY key',
    [projectPath, now]
  );
}
