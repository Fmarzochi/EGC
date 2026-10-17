#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveStateStorePath } = require(path.join(__dirname, '..', 'lib', 'state-store', 'path.js'));
const { openCompatDatabase, selectedEngine } = require(path.join(__dirname, '..', 'lib', 'state-store', 'sqlite-compat.js'));
const { applyMigrationsAsync } = require(path.join(__dirname, '..', 'lib', 'state-store', 'migrations.js'));
const { assertValidEntity } = require(path.join(__dirname, '..', 'lib', 'state-store', 'schema.js'));
const { readHookStdinAsync } = require(path.join(__dirname, '..', 'lib', 'hook-stdin.js'));

const INSERT_RUNTIME_EVENT_SQL = `
  INSERT INTO events (
    id,
    session_id,
    event_type,
    payload,
    timestamp
  ) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    session_id = excluded.session_id,
    event_type = excluded.event_type,
    payload = excluded.payload,
    timestamp = excluded.timestamp
`;

const UPSERT_SESSION_SQL = `
  INSERT INTO sessions (
    id,
    adapter_id,
    harness,
    state,
    repo_root,
    started_at,
    ended_at,
    snapshot,
    input_tokens,
    output_tokens,
    total_tokens,
    token_cost
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    adapter_id = excluded.adapter_id,
    harness = excluded.harness,
    state = excluded.state,
    repo_root = excluded.repo_root,
    started_at = excluded.started_at,
    ended_at = excluded.ended_at,
    snapshot = excluded.snapshot,
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    total_tokens = excluded.total_tokens,
    token_cost = excluded.token_cost
`;

// The payload comes through the shared stream reader: a synchronous read of
// descriptor 0 is not reliable on a Windows pipe (it can fail with EAGAIN or
// EOF before the parent's bytes are seen), and a read failure swallowed in
// silence meant an event lost with exit code 0. Empty input stays a quiet
// no-op (a direct invocation); a cut-off stream or a malformed payload is
// said on stderr, so a lost event always leaves a trace.
function payloadFromInput({ raw, truncated }) {
  if (truncated) {
    console.error('[state-db-writer] the hook input was cut off or the stream failed; the event is not recorded');
    return null;
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[state-db-writer] the hook input is not JSON (${err.message}); the event is not recorded`);
    return null;
  }
}

async function persistSessionEnd(db, payload) {
  const sid = payload.session_id;
  if (!sid) return;
  const usage = payload.usage || {};
  const inputTokens  = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const totalTokens  = (Number.isFinite(inputTokens) && Number.isFinite(outputTokens))
    ? inputTokens + outputTokens
    : null;

  const session = {
    id: sid,
    adapterId: payload.ide || payload.adapter_id || 'unknown',
    harness: payload.harness || 'unknown',
    state: 'ended',
    repoRoot: payload.repo_root || null,
    startedAt: payload.started_at || null,
    endedAt: new Date().toISOString(),
    snapshot: {
      ide: payload.ide,
      model: payload.model || null,
      workers: payload.workers || [],
    },
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
    totalTokens,
    tokenCost: null,
  };

  try {
    assertValidEntity('session', session);
  } catch (err) {
    console.error(`[state-db-writer] Invalid session entity: ${err.message}`);
    return;
  }

  await db.run(UPSERT_SESSION_SQL, [
    session.id,
    session.adapterId,
    session.harness,
    session.state,
    session.repoRoot,
    session.startedAt,
    session.endedAt,
    JSON.stringify(session.snapshot),
    session.inputTokens,
    session.outputTokens,
    session.totalTokens,
    session.tokenCost,
  ]);
}

const WAL_SWITCH_ATTEMPTS = 20;
const WAL_SWITCH_RETRY_MS = 50;

// Switching the journal mode needs the file to itself, and the busy handler
// does not always cover that step: several hook writers starting on a fresh
// store at the same moment have seen SQLITE_BUSY here. The switch is tried
// for a short while and then left to the next writer. WAL is a performance
// setting, not a correctness one; every write below waits through
// busy_timeout whatever the mode.
async function enableWalBestEffort(db, attempt = 0) {
  try {
    const modeRow = await db.get('PRAGMA journal_mode;');
    const currentMode = modeRow ? Object.values(modeRow)[0] : null;
    if (typeof currentMode !== 'string' || currentMode.toLowerCase() !== 'wal') {
      await db.exec('PRAGMA journal_mode = WAL;');
    }
  } catch (err) {
    if (err?.code !== 'SQLITE_BUSY') throw err;
    if (attempt + 1 >= WAL_SWITCH_ATTEMPTS) return;
    await new Promise(resolve => setTimeout(resolve, WAL_SWITCH_RETRY_MS));
    await enableWalBestEffort(db, attempt + 1);
  }
}

// How long a hook write waits for the store while another writer has it.
// On Windows a persist (write, flush, rename) is several times slower, and
// with a few sessions and the CLI writing at once the queue outlasted the
// 4 s the other platforms need: the writer gave up and, since a hook exits
// 0 by design, the event was lost without a word. Windows gets the lock's
// own default budget.
function hookLockTimeoutMs(platform = process.platform) {
  return platform === 'win32' ? 15000 : 4000;
}

const HOOK_LOCK_TIMEOUT_MS = hookLockTimeoutMs();

async function initDatabase(dbPath) {
  const db = await openCompatDatabase(dbPath, 'state-db-writer', { lockTimeoutMs: HOOK_LOCK_TIMEOUT_MS });
  if (selectedEngine() === 'native') {
    try {
      await db.exec(`PRAGMA busy_timeout = ${HOOK_LOCK_TIMEOUT_MS};`);
      await enableWalBestEffort(db);
      await db.exec('PRAGMA synchronous = NORMAL;');
    } catch (pragmaErr) {
      try { await db.close(); } catch (_) { /* ignore close error */ }
      throw pragmaErr;
    }
  }
  await applyMigrationsAsync(db);
  return db;
}

const STORE_WAIT_MS = 25;
// While another writer holds the lock the wait matches the lock timeout
// above; with no lock the path is only rechecked for an instant.
const STORE_WAIT_LOCKED_ATTEMPTS = Math.ceil(HOOK_LOCK_TIMEOUT_MS / STORE_WAIT_MS);
const STORE_WAIT_UNLOCKED_ATTEMPTS = 4;

// The portable engine persists by renaming a new file over the store, and
// on Windows that rename is not atomic: for an instant the path has no
// file. A writer starting at that instant must not take the store for
// absent. While the lock sidecar says another writer is mid-persist the
// check is repeated for as long as that writer may hold the lock; with no
// sidecar but the store directory in place (the instant between the rename
// and the release) it is repeated a few times before giving up. A missing
// directory is EGC not initialized: a quiet no-op at once.
async function storeExists(dbPath, attempt = 0) {
  if (fs.existsSync(dbPath)) return true;
  if (!fs.existsSync(path.dirname(dbPath))) return false;
  const limit = fs.existsSync(`${dbPath}.db-lock`) ? STORE_WAIT_LOCKED_ATTEMPTS : STORE_WAIT_UNLOCKED_ATTEMPTS;
  if (attempt + 1 >= limit) return false;
  await new Promise(resolve => setTimeout(resolve, STORE_WAIT_MS));
  return storeExists(dbPath, attempt + 1);
}

async function main() {
  const payload = payloadFromInput(await readHookStdinAsync());
  if (!payload) return;

  const dbPath = resolveStateStorePath();
  if (!(await storeExists(dbPath))) return;

  let db;
  try {
    db = await initDatabase(dbPath);
  } catch (e) {
    console.error(e);
    return;
  }

  const eventType = payload.event_type || payload.type || payload.hook_event_name || 'observe';

  try {
    const event = {
      id: crypto.randomUUID(),
      sessionId: payload.session_id || process.env.EGC_SESSION_ID || process.env.ECC_SESSION_ID || null,
      eventType,
      payload,
      timestamp: new Date().toISOString(),
    };

    try {
      assertValidEntity('runtimeEvent', event);
    } catch (err) {
      console.error(`[state-db-writer] Invalid runtimeEvent entity: ${err.message}`);
      return;
    }

    await db.run(INSERT_RUNTIME_EVENT_SQL, [
      event.id,
      event.sessionId,
      event.eventType,
      JSON.stringify(event.payload),
      event.timestamp,
    ]);

    // On session_end events persist token data to the sessions table
    if (eventType === 'session_end' || (payload.event === 'session_end')) {
      await persistSessionEnd(db, payload);
    }
  } catch (e) {
    console.error(e);
  } finally {
    try {
      await db.close();
    } catch (e) {
      console.error(e);
    }
  }
}

module.exports = { hookLockTimeoutMs };

if (require.main === module) {
  main().catch((e) => { console.error(e); }).finally(() => process.exit(0));
}
