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

const fs = require('node:fs');
const path = require('node:path');

// Each skipped pragma runs to its terminator on the same line; no anchor
// and no whitespace class that can span lines, so nothing backtracks.
const SKIPPED_PRAGMA = /\bPRAGMA[ \t]+(?:journal_mode|busy_timeout|synchronous)\b[^;\n]*;?/gi;
// A trimmed statement counts as a plain read only when it is a SELECT, an
// EXPLAIN, or a pragma that merely reports a value. Everything else (writes,
// DDL, ANALYZE, VACUUM, value-setting pragmas, any CTE) reaches the file; a
// read misclassified as a write costs one extra save and nothing more.
const READ_ONLY_STATEMENT = /^(?:SELECT\b|EXPLAIN\b|PRAGMA[ \t]+[a-z_]+$)/i;
const NATIVE_FAILURE_MESSAGE = /GLIBC|dlopen|bindings file|\.node'?:|invalid ELF header|not a valid Win32 application|Symbol not found/i;

let sqlJsPromise = null;
let fallbackAnnounced = false;
let selected = 'native';

function errorMessage(error) {
  if (error instanceof Error) return error.message.split('\n')[0];
  return String(error).split('\n')[0];
}

function loadSqlJs() {
  if (!sqlJsPromise) {
    const initSqlJs = require('sql.js');
    sqlJsPromise = initSqlJs();
  }
  return sqlJsPromise;
}

function isNativeLoadFailure(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.code === 'ERR_DLOPEN_FAILED' || error.code === 'MODULE_NOT_FOUND') return true;
  return NATIVE_FAILURE_MESSAGE.test(errorMessage(error));
}

function mutates(sql) {
  const statements = sql.split(';').map(part => part.trim()).filter(Boolean);
  return statements.some(statement => !READ_ONLY_STATEMENT.test(statement));
}

function namedKey(key) {
  return /^[$:@]/.test(key) ? key : `$${key}`;
}

function nullForUndefined(value) {
  return value ?? null;
}

// The `sqlite` package accepts (sql, a, b), (sql, [a, b]) and (sql, {name}).
// sql.js binds arrays positionally and objects by $name/:name/@name.
function normalizeParams(params) {
  if (params.length === 0) return undefined;
  if (params.length > 1) return params.map(nullForUndefined);
  const only = params[0];
  if (Array.isArray(only)) return only.map(nullForUndefined);
  if (only && typeof only === 'object' && !(only instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(only).map(([key, value]) => [namedKey(key), nullForUndefined(value)]));
  }
  return [nullForUndefined(only)];
}

class WasmDatabase {
  constructor(db, filename) {
    this.db = db;
    this.filename = filename;
    this.persistTimer = null;
    this.closed = false;
  }

  async run(sql, ...params) {
    this.db.run(sql, normalizeParams(params));
    const changes = this.db.getRowsModified();
    const row = await this.get('SELECT last_insert_rowid() AS id');
    if (mutates(sql)) this.schedulePersist();
    return { lastID: Number(row?.id ?? 0), changes };
  }

  async get(sql, ...params) {
    const rows = await this.all(sql, ...params);
    return rows[0];
  }

  async all(sql, ...params) {
    const statement = this.db.prepare(sql);
    try {
      const bound = normalizeParams(params);
      if (bound) statement.bind(bound);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }

  // sql.js runs a multi-statement string itself (so trigger bodies with
  // BEGIN ... END stay intact) and stops at the first error, like the native
  // driver. WAL, busy timeout and synchronous pragmas only mean something to
  // the native engine, so they are dropped from the text rather than failed.
  async exec(sql) {
    const text = sql.replace(SKIPPED_PRAGMA, '');
    if (text.trim()) this.db.exec(text);
    if (mutates(sql)) this.schedulePersist();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.persistNow();
    this.db.close();
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      // A failed background write must not take the server down; the next
      // mutation retries, and close() surfaces the error to its caller.
      try {
        this.persistNow();
      } catch (error) {
        process.stderr.write(`[sqlite-compat] could not persist ${this.filename}: ${errorMessage(error)}\n`);
      }
    }, 25);
    this.persistTimer.unref();
  }

  persistNow() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.filename === ':memory:') return;
    const tmp = `${this.filename}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    fs.writeFileSync(tmp, Buffer.from(this.db.export()));
    fs.renameSync(tmp, this.filename);
  }
}

// A write-ahead log left behind by a native engine (a crash, or a
// connection still open elsewhere) holds committed rows that only the
// native engine can fold back into the main file; reading the main file
// alone would silently drop them.
function assertNoPendingWal(filename) {
  if (filename === ':memory:') return;
  const wal = `${filename}-wal`;
  let size;
  try {
    size = fs.statSync(wal).size;
  } catch (error) {
    // Only a missing sidecar means there is nothing to fold back; a
    // permission or I/O error must not be mistaken for that.
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  if (size > 0) {
    throw new Error(`${wal} holds ${size} bytes of write-ahead data that the portable engine cannot read; open the database once with a working native sqlite3 so it is checkpointed, or restore a clean copy, before using the portable engine.`);
  }
}

async function openWasmDatabase(filename) {
  assertNoPendingWal(filename);
  const SQL = await loadSqlJs();
  const data = filename !== ':memory:' && fs.existsSync(filename)
    ? new Uint8Array(fs.readFileSync(filename))
    : undefined;
  const wasm = new WasmDatabase(new SQL.Database(data), filename);
  process.once('exit', () => { void wasm.close(); });
  return wasm;
}

function announceFallback(serverName, error) {
  if (fallbackAnnounced) return;
  fallbackAnnounced = true;
  process.stderr.write(`[${serverName}] native sqlite3 unavailable (${errorMessage(error)}); using the portable sql.js engine. Cross-process locking is reduced on this machine.\n`);
}

async function openCompatDatabase(filename, serverName) {
  const engine = process.env.EGC_SQLITE_ENGINE;
  if (engine !== 'wasm') {
    try {
      const sqlite3 = require('sqlite3');
      const { open } = require('sqlite');
      const db = await open({ filename, driver: sqlite3.Database });
      selected = 'native';
      return db;
    } catch (error) {
      if (engine === 'native' || !isNativeLoadFailure(error)) throw error;
      announceFallback(serverName, error);
    }
  }
  selected = 'wasm';
  return openWasmDatabase(filename);
}

// The engine the last openCompatDatabase call settled on: 'native' or 'wasm'.
function selectedEngine() {
  return selected;
}

module.exports = { openCompatDatabase, selectedEngine, isNativeLoadFailure, normalizeParams, WasmDatabase };
