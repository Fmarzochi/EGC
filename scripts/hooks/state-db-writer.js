#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveStateStorePath } = require(path.join(__dirname, '..', 'lib', 'state-store', 'path.js'));
const { openCompatDatabase, selectedEngine } = require(path.join(__dirname, '..', 'lib', 'state-store', 'sqlite-compat.js'));
const { applyMigrationsAsync } = require(path.join(__dirname, '..', 'lib', 'state-store', 'migrations.js'));
const { assertValidEntity } = require(path.join(__dirname, '..', 'lib', 'state-store', 'schema.js'));

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

function readPayloadFromStdin() {
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) { // NOSONAR
    // Intentional: writer is best-effort; absent stdin (e.g., direct invocation) is a no-op.
    return null;
  }

  if (!raw.trim()) return null;

  try {
    return JSON.parse(raw);
  } catch (_) { // NOSONAR: malformed payload is ignored; writer is fire-and-forget
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

async function initDatabase(dbPath) {
  const db = await openCompatDatabase(dbPath, 'state-db-writer', { lockTimeoutMs: 4000 });
  if (selectedEngine() === 'native') {
    try {
      await db.exec('PRAGMA busy_timeout = 4000;');
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

async function main() {
  const payload = readPayloadFromStdin();
  if (!payload) return;

  const dbPath = resolveStateStorePath();
  if (!fs.existsSync(dbPath)) return;

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

main().catch((e) => { console.error(e); }).finally(() => process.exit(0));
