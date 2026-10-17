import { Database } from 'sqlite';
import { openCompatDatabase } from './sqlite-compat';
import path from 'node:path';
import fs from 'node:fs';
import { log, ensurePrivateDir, hideEgcRootOnWindows } from './memory-logging';
import { resolveHome } from './home';
import { createSearchIndex, rebuildSearchIndex, createLessonsSearchIndex, rebuildLessonsSearchIndex } from './search.js';
import { createSessionBusTables } from './session-bus';
import { createWorkingMemoryTable, createWorkingMemoryExpiryIndex } from './working-memory';
import { SQLiteArbitrationQueue } from './write-queue';

let searchIndexReady = false;
let lessonsSearchIndexReady = false;

export function isSearchIndexReady(): boolean {
  return searchIndexReady;
}

export function isLessonsSearchIndexReady(): boolean {
  return lessonsSearchIndexReady;
}

// FTS5 sync triggers written by an FTS5-capable engine (decisions_fts_after_*,
// lessons_fts_after_*) reference the virtual table on every write, so a
// build without FTS5 has to remove them to keep inserting at all.
interface FtsIndexSpec {
  version: number;
  triggerPrefix: string;
  table: string;
  create: (db: Database) => Promise<void>;
  rebuild: (db: Database) => Promise<void>;
  fallbackNote: string;
}

// Creates or repairs one FTS5 index and reports whether it is usable. The
// statements are idempotent, so they run on every start: a build without
// FTS5 drops the sync triggers (they would break every write) and the next
// FTS5-capable start puts them back and backfills the index.
async function ensureFtsIndex(db: Database, spec: FtsIndexSpec): Promise<boolean> {
  const recorded = await db.get('SELECT version FROM schema_migrations WHERE version = ?', [spec.version]);
  try {
    const triggers = await countFtsTriggers(db, spec.triggerPrefix);
    await spec.create(db);
    // IF NOT EXISTS leaves an existing index untouched without loading the
    // module, so touch the virtual table to learn whether FTS5 is here.
    await db.get(`SELECT 1 FROM ${spec.table} LIMIT 1`);
    if (!recorded || triggers < 3) {
      await spec.rebuild(db);
    }
    if (!recorded) {
      await db.run('INSERT INTO schema_migrations (version) VALUES (?)', [spec.version]);
    }
    return true;
  } catch (e) {
    await dropFtsTriggers(db, spec.triggerPrefix);
    log('WARN', spec.fallbackNote, { error: String(e) });
    return false;
  }
}

async function countFtsTriggers(db: Database, prefix: string): Promise<number> {
  const row = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE ?", [`${prefix}%`]);
  return Number(row?.n ?? 0);
}

async function dropFtsTriggers(db: Database, prefix: string): Promise<void> {
  for (const suffix of ['insert', 'delete', 'update']) {
    try {
      await db.exec(`DROP TRIGGER IF EXISTS ${prefix}${suffix}`); // NOSONAR: sequential by design, DDL statements on the same sqlite handle, run one at a time to avoid lock contention
    } catch (error) {
      log('WARN', 'Could not drop an FTS5 sync trigger', { trigger: `${prefix}${suffix}`, error: String(error) });
    }
  }
}

// ============================================================================
// SQLite Arbitration & Message Queue (Cross-Runtime Synchronization)
// Orchestrates shared memory writes with exponential backoff to prevent IDE crashes
// ============================================================================
export const writeArbitrator = new SQLiteArbitrationQueue({ log });

// ============================================================================
// Boot & Migrations
// ============================================================================
export function clearStaleMigrationLock(lockFile: string) {
  if (!fs.existsSync(lockFile)) return;
  try {
    const storedPid = Number.parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
    if (!Number.isNaN(storedPid) && storedPid !== process.pid) {
      // Check if the PID is still alive (POSIX: signal 0 = probe only)
      let alive = false;
      try { process.kill(storedPid, 0); alive = true; } catch (_) { // NOSONAR: probe failure means the PID is dead
        // non-critical: if signal probe fails, treat PID as dead and clear lock
      }
      if (!alive) fs.unlinkSync(lockFile);
    }
  } catch (e) {
    // non-critical: if lock file is unreadable, proceed and attempt to acquire
    console.error('[EGC memory] Could not read migration lock file:', String(e));
  }
}

export async function acquireMigrationLock(lockFile: string): Promise<void> {
  let locked = false;
  let retries = 50;
  while (!locked && retries > 0) {
    try {
      fs.writeFileSync(lockFile, process.pid.toString(), { flag: 'wx' });
      locked = true;
    } catch { // NOSONAR: lock contention is handled by the retry loop below
      retries--;
      await new Promise(r => setTimeout(r, 100)); // NOSONAR: the retries wait one after the other on purpose (S9382)
    }
  }
  if (!locked) throw new Error('Timeout acquiring migration lock');
}

async function runMigrations(db: Database, dbDir: string) {
  const lockFile = path.join(dbDir, 'migration.lock');

  clearStaleMigrationLock(lockFile);
  await acquireMigrationLock(lockFile);

  try {
    log('INFO', 'Running SQLite migrations');
    await db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
      CREATE TABLE IF NOT EXISTS operational_state (id TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context TEXT, decision TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
      COMMIT;
    `);

    // Migration 2: FTS5 index over decisions for BM25 keyword search.
    // Triggers keep the index in sync incrementally on every write; the
    // one-time rebuild backfills rows stored before this migration existed.
    searchIndexReady = await ensureFtsIndex(db, {
      version: 2,
      triggerPrefix: 'decisions_fts_after_',
      table: 'decisions_fts',
      create: createSearchIndex,
      rebuild: rebuildSearchIndex,
      fallbackNote: 'FTS5 unavailable, search_history falls back to substring matching',
    });

    // Migration 3: working_memory table for transient, TTL-bounded entries.
    const hasV3 = await db.get('SELECT version FROM schema_migrations WHERE version = 3');
    if (!hasV3) {
      await createWorkingMemoryTable(db);
      await db.run('INSERT INTO schema_migrations (version) VALUES (3)');
    }

    // Migration 4: lessons table with confidence decay support.
    const hasV4 = await db.get('SELECT version FROM schema_migrations WHERE version = 4');
    if (!hasV4) {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS lessons (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          context TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.7,
          last_reinforced TEXT,
          last_recalled TEXT,
          created_at TEXT NOT NULL,
          tags TEXT,
          archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_lessons_confidence_created_at
          ON lessons (confidence DESC, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_lessons_archived_confidence
          ON lessons (archived, confidence DESC);
      `);
      await db.run('INSERT INTO schema_migrations (version) VALUES (4)');
    }

    // Migration 5: FTS5 index over lessons for BM25 keyword search.
    // Mirrors the decisions_fts pattern; triggers keep the index in sync on
    // every write and a one-time rebuild backfills lessons from Migration 4.
    lessonsSearchIndexReady = await ensureFtsIndex(db, {
      version: 5,
      triggerPrefix: 'lessons_fts_after_',
      table: 'lessons_fts',
      create: createLessonsSearchIndex,
      rebuild: rebuildLessonsSearchIndex,
      fallbackNote: 'FTS5 unavailable for lessons, lesson_recall falls back to substring matching',
    });

    // Migration 6: project_path column in lessons for per-project lesson scoping.
    const hasV6 = await db.get('SELECT version FROM schema_migrations WHERE version = 6');
    if (!hasV6) {
      await db.exec('ALTER TABLE lessons ADD COLUMN project_path TEXT');
      await db.run('INSERT INTO schema_migrations (version) VALUES (6)');
    }

    // Migration 7: project_path column in decisions for per-project scoping.
    const hasV7 = await db.get('SELECT version FROM schema_migrations WHERE version = 7');
    if (!hasV7) {
      await db.exec('ALTER TABLE decisions ADD COLUMN project_path TEXT');
      await db.run('INSERT INTO schema_migrations (version) VALUES (7)');
    }

    // Migration 8: sessions table for time-aware session tracking.
    const hasV8 = await db.get('SELECT version FROM schema_migrations WHERE version = 8');
    if (!hasV8) {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          project_path TEXT,
          tool TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT
        );
      `);
      await db.run('INSERT INTO schema_migrations (version) VALUES (8)');
    }

    // Migration 9: author column in lessons and decisions for team memory attribution.
    const hasV9 = await db.get('SELECT version FROM schema_migrations WHERE version = 9');
    if (!hasV9) {
      await db.exec('ALTER TABLE lessons ADD COLUMN author TEXT DEFAULT NULL');
      await db.run('INSERT INTO schema_migrations (version) VALUES (9)');
    }

    // Migration 10: session bus tables for presence and cooperative path locks.
    const hasV10 = await db.get('SELECT version FROM schema_migrations WHERE version = 10');
    if (!hasV10) {
      await createSessionBusTables(db);
      await db.run('INSERT INTO schema_migrations (version) VALUES (10)');
    }

    // Migration 11: session bus event queue (bus_events, bus_event_cursors).
    // The shared creator only issues CREATE IF NOT EXISTS, so rerunning it is safe.
    const hasV11 = await db.get('SELECT version FROM schema_migrations WHERE version = 11');
    if (!hasV11) {
      await createSessionBusTables(db);
      await db.run('INSERT INTO schema_migrations (version) VALUES (11)');
    }

    // Migration 12: index on working_memory.expires_at, read by the sweep that
    // every working memory read now runs.
    const hasV12 = await db.get('SELECT version FROM schema_migrations WHERE version = 12');
    if (!hasV12) {
      await createWorkingMemoryExpiryIndex(db);
      await db.run('INSERT INTO schema_migrations (version) VALUES (12)');
    }

    const bootRow = await db.get<{value: string}>('SELECT value FROM operational_state WHERE id = ?', ['server_boot_count']);
    const bootCount = bootRow ? Number.parseInt(bootRow.value, 10) + 1 : 1;
    await db.run('INSERT OR REPLACE INTO operational_state (id, value) VALUES (?, ?)', ['server_boot_count', String(bootCount)]);
  } finally {
    try { fs.unlinkSync(lockFile); } catch(e) {
      // non-critical: stale lock will be cleaned up on next boot
      console.error('[EGC memory] Could not remove migration lock:', String(e));
    }
  }
}

// Note (BUG-08): The MCP memory server uses `~/.egc/memory/state.db` whereas
// the standard harness state-store logic (resolveStateStoreDbPath) uses
// `~/.egc/egc/state.db`. This is a known architectural divergence where
// CLI/harness telemetry and MCP memory state are stored in separate SQLite DBs.
// A doctor check in scripts/doctor.js warns when these databases diverge.
// Single source of truth for the memory store location: getDb() opens the
// database here and the mesh transport watches the same path for changes.
export function getMemoryDbDir(): string {
  return path.join(resolveHome(), '.egc', 'memory');
}

let dbInstance: Database | null = null;
let dbInitPromise: Promise<Database> | null = null;

export async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;
  if (dbInitPromise !== null) return dbInitPromise;

  dbInitPromise = (async () => {
    try {
      const dbDir = getMemoryDbDir();
      ensurePrivateDir(dbDir);
      hideEgcRootOnWindows();

      const dbPath = path.join(dbDir, 'state.db');
      dbInstance = await openCompatDatabase(dbPath, 'egc-memory');

      // The wait goes in before anything that takes the store's lock:
      // switching to WAL does, and another process starting at the same
      // moment may hold it, so the switch waits for it like every later query.
      await dbInstance.exec('PRAGMA busy_timeout = 5000;');
      await dbInstance.exec('PRAGMA journal_mode = WAL;');
      await dbInstance.exec('PRAGMA synchronous = NORMAL;');
      await dbInstance.exec('PRAGMA foreign_keys = ON;');

      await runMigrations(dbInstance, dbDir);
      return dbInstance;
    } catch (error) {
      dbInitPromise = null;
      dbInstance = null;
      throw error;
    }
  })();

  return dbInitPromise;
}

export async function closeDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.close();
    log('INFO', 'SQLite handle closed');
  }
}

export async function getMaintenanceState(db: Database, key: string): Promise<string | null> {
  const row = await db.get<{value: string}>('SELECT value FROM operational_state WHERE id = ?', [key]);
  return row?.value ?? null;
}

export async function setMaintenanceState(db: Database, key: string, value: string): Promise<void> {
  await db.run('INSERT OR REPLACE INTO operational_state (id, value) VALUES (?, ?)', [key, value]);
}
