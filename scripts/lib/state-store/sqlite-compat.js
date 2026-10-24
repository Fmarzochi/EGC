'use strict';

// Opens a SQLite database for the MCP servers with the native sqlite3
// driver and, when that driver cannot load on this machine, with the
// portable sql.js engine behind the same async API (run, get, all, exec,
// close). The native binary published with sqlite3 6.x is built against a
// glibc newer than Debian 12, Ubuntu 22.04 and similar hosts carry, and
// loading it fails with ERR_DLOPEN_FAILED; the CLI already survives that
// through db-adapter.js, and both servers load this module from the
// package root (mcp/servers/<name>/build -> scripts/lib/state-store).
//
// EGC_SQLITE_ENGINE=native  never fall back (surface the native error)
// EGC_SQLITE_ENGINE=wasm    always use sql.js (used by the fallback tests)


// The lock protocol, the SQL text helpers and the portable engine live in
// the three sibling modules; this file chooses the engine and re-exports
// what the servers, the CLI adapter and the hooks import from here.

const { acquireFileLock, acquireFileLockSync, releaseFileLock, isProcessAlive, renameOverSync, readFileWithIdentity } = require('./sqlite-compat-lock');
const { normalizeParams, mutates, splitStatements } = require('./sqlite-compat-sql');
const { errorMessage, isNativeLoadFailure, WasmDatabase, assertNoPendingWal, openWasmDatabase } = require('./sqlite-compat-wasm');

let fallbackAnnounced = false;
let selected = 'native';

// How long a native connection waits for a file another connection holds.
const NATIVE_BUSY_TIMEOUT_MS = 4000;

function announceFallback(serverName, error) {
  if (fallbackAnnounced) return;
  fallbackAnnounced = true;
  process.stderr.write(`[${serverName}] native sqlite3 unavailable (${errorMessage(error)}); using the portable sql.js engine. Cross-process locking is reduced on this machine.\n`);
}

// options.reader is for a process that reads a store it does not own, such
// as the dashboard counting the memory server's rows. It never creates the
// store or changes its rows: the native engine opens without the create
// flag, so a missing file is an error instead of a new empty store, the
// portable engine never writes the file back, and nothing is said on stderr.
// The native reader still opens read-write, because a read-only connection
// cannot fold a write-ahead log left by a dead owner and would recover it on
// every open; with no other connection open, closing folds that log into the
// file, as the owner's next start would. The mode is passed whole, so it
// names the full mutex the driver otherwise adds by itself.
async function openCompatDatabase(filename, serverName, options = {}) {
  const engine = process.env.EGC_SQLITE_ENGINE;
  const reader = options.reader === true;
  let nativeError = null;
  if (engine !== 'wasm') {
    try {
      const sqlite3 = require('sqlite3');
      const { open } = require('sqlite');
      const mode = reader ? { mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_FULLMUTEX } : {};
      const db = await open({ filename, driver: sqlite3.Database, ...mode });
      // The driver answers SQLITE_BUSY at once while another connection holds
      // the file; ten processes starting together on Windows saw it. Every
      // connection the chooser opens waits instead, and a caller that wants
      // a longer wait sets its own pragma after this one.
      await db.exec(`PRAGMA busy_timeout = ${NATIVE_BUSY_TIMEOUT_MS}`);
      selected = 'native';
      return db;
    } catch (error) {
      if (engine === 'native' || !isNativeLoadFailure(error)) throw error;
      nativeError = error;
    }
  }
  selected = 'wasm';
  const db = await openWasmDatabase(filename, nativeError, options);
  // Said only once the portable engine is open: announcing it before a
  // failed open would tell the reader an engine is in use when none is.
  if (nativeError && !reader) announceFallback(serverName, nativeError);
  return db;
}

// The engine the last openCompatDatabase call settled on: 'native' or 'wasm'.
function selectedEngine() {
  return selected;
}

// Switching the journal mode needs the file to itself, and the busy handler
// does not always cover that step: processes opening the same store at the
// same moment see SQLITE_BUSY there (the hook writers first, then the memory
// server on a saturated runner). WAL is a performance setting, not a
// correctness one: the switch is retried for a short while and then left to
// the next opener; every query still waits through busy_timeout.
const WAL_SWITCH_ATTEMPTS = 20;
const WAL_SWITCH_RETRY_MS = 50;

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

module.exports = { openCompatDatabase, selectedEngine, enableWalBestEffort, isNativeLoadFailure, normalizeParams, mutates, splitStatements, WasmDatabase, acquireFileLock, acquireFileLockSync, releaseFileLock, isProcessAlive, assertNoPendingWal, renameOverSync, readFileWithIdentity };
