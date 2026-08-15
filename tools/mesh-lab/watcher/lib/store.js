'use strict';
// Minimal store layer for the lab: the same bus_events shape the production
// session bus uses (mcp/servers/egc-memory/src/session-bus.ts), opened in
// WAL mode. The lab reads and writes events directly so the prototype
// exercises the transport itself, not the MCP server around it.

const DDL = `
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
`;

async function openStore(driver, dbPath) {
  const db = await driver.open({ filename: dbPath, driver: driver.sqlite3.Database });
  try {
    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('PRAGMA synchronous = NORMAL;');
    await db.exec('PRAGMA busy_timeout = 10000;');
    await db.exec(DDL);
    return db;
  } catch (err) {
    // The caller never receives the handle on a failed init, so it must be
    // closed here or the descriptor leaks with no owner.
    await db.close().catch(() => {});
    throw err;
  }
}

async function insertEvent(db, { from, kind, payload }) {
  const result = await db.run(
    'INSERT INTO bus_events (from_session, to_session, project_path, kind, payload, created_at) VALUES (?, NULL, NULL, ?, ?, ?)',
    from, kind, payload, new Date().toISOString()
  );
  return result.lastID;
}

async function maxEventId(db) {
  const row = await db.get('SELECT COALESCE(MAX(id), 0) AS top FROM bus_events');
  return Number(row.top);
}

async function readSince(db, afterId, limit = 500) {
  return db.all(
    'SELECT id, from_session, kind, payload, created_at FROM bus_events WHERE id > ? ORDER BY id ASC LIMIT ?',
    afterId, limit
  );
}

module.exports = { openStore, insertEvent, maxEventId, readSince };
