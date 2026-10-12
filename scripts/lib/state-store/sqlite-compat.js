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
const crypto = require('node:crypto');
const os = require('node:os');

// Pragmas that only mean something to the native engine (WAL, busy
// timeout, synchronous) are dropped from the text before sql.js sees it.
const SKIPPED_PRAGMA = /^PRAGMA[ \t]+(?:journal_mode|busy_timeout|synchronous)\b/i;
// A trimmed statement counts as a plain read only when it is a SELECT, an
// EXPLAIN, or a bare pragma from the allowlist of value-reporting pragmas.
// Everything else (writes, DDL, ANALYZE, VACUUM, value-setting pragmas,
// PRAGMA optimize, any CTE, any pragma not on the list) reaches the file; a
// read misclassified as a write costs one extra save and nothing more.
const REPORTING_PRAGMA = /^PRAGMA[ \t]+(?:user_version|schema_version|application_id|journal_mode|synchronous|foreign_keys|busy_timeout|page_size|page_count|freelist_count|integrity_check|quick_check|compile_options|database_list|table_list|collation_list|encoding)$/i;
const READ_ONLY_STATEMENT = /^(?:SELECT\b|EXPLAIN\b)/i;
const NATIVE_FAILURE_MESSAGE = /GLIBC|dlopen|bindings file|\.node'?:|invalid ELF header|not a valid Win32 application|Symbol not found/i;

let sqlJsPromise = null;
let fallbackAnnounced = false;
let selected = 'native';

class InProcessMutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    await new Promise(resolve => this._queue.push(resolve));
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }
}

const fileMutexes = new Map();
function getFileMutex(filepath) {
  let m = fileMutexes.get(filepath);
  if (!m) {
    m = new InProcessMutex();
    fileMutexes.set(filepath, m);
  }
  return m;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    return true;
  }
}

function tryAcquireLockOnce(lockPath, token) {
  let fd;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    const payload = JSON.stringify({
      token,
      pid: process.pid,
      acquiredAt: Date.now(),
      hostname: os.hostname(),
    });
    fs.writeFileSync(fd, payload);
    return true;
  } catch (writeErr) {
    let isOurFile = false;
    try {
      const fstat = fs.fstatSync(fd);
      const stat = fs.statSync(lockPath);
      isOurFile = (fstat.ino && stat.ino) ? fstat.ino === stat.ino : stat.size === 0;
    } catch (_) {
      isOurFile = false;
    }
    try { fs.closeSync(fd); } catch (_) { /* ignore close error */ }
    fd = undefined;
    if (isOurFile) {
      try { fs.unlinkSync(lockPath); } catch (_) { /* ignore unlink error */ }
    }
    throw writeErr;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* ignore close error */ }
    }
  }
}

function releaseFileLock(lockPath, token) {
  if (!token || typeof token !== 'string') return;
  try {
    if (!fs.existsSync(lockPath)) return;
    const raw = fs.readFileSync(lockPath, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.token === token) {
      fs.unlinkSync(lockPath);
    }
  } catch (_) { /* ignore release error */ }
}

async function acquireFileLock(lockPath, { timeoutMs = 15000, retryIntervalMs = 25 } = {}) {
  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  let lastHolder = null;

  while (Date.now() < deadline) {
    if (tryAcquireLockOnce(lockPath, token)) {
      return token;
    }

    let holder = null;
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      if (raw.trim()) {
        holder = JSON.parse(raw);
        lastHolder = holder;
      }
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      // Malformed JSON or transient read error: fail closed by continuing to wait
    }

    if (holder) {
      const sameHost = holder.hostname === os.hostname();
      const isValidPid = Number.isInteger(holder.pid) && holder.pid > 0;
      const isDeadLocalPid = sameHost && isValidPid && !isProcessAlive(holder.pid);
      if (isDeadLocalPid && fs.existsSync(lockPath)) {
        throw new Error(
          `[sqlite-compat] Lock file "${lockPath}" is held by dead process PID ${holder.pid} on host ${holder.hostname}. ` +
          `Automatic stale-lock recovery is disabled to ensure strict mutual exclusion. ` +
          `To recover manually, verify that process ${holder.pid} is not running, then remove the lock file: rm "${lockPath}"`
        );
      }
    }

    const jitter = crypto.randomInt(0, 20);
    await new Promise(r => setTimeout(r, retryIntervalMs + jitter));
  }

  const hostInfo = (lastHolder && lastHolder.hostname && lastHolder.hostname !== os.hostname()) ? ` on host ${lastHolder.hostname}` : '';
  const holderInfo = lastHolder ? ` (held by PID ${lastHolder.pid}${hostInfo}, token ${lastHolder.token})` : '';
  throw new Error(`[sqlite-compat] Lock timeout after ${timeoutMs}ms acquiring ${lockPath}${holderInfo}`);
}

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

// Splits SQL text into statements on the semicolons that sit outside
// single- and double-quoted literals, so a literal such as
// 'PRAGMA synchronous = NORMAL;' stays part of its SELECT. Joining the
// pieces back with ';' reproduces the original text exactly, trigger
// bodies included.
function splitStatements(sql) {
  const pieces = [];
  let start = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ';') {
      pieces.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(sql.slice(start));
  return pieces;
}

function isReadOnly(statement) {
  const trimmed = statement.trim();
  return trimmed === '' || READ_ONLY_STATEMENT.test(trimmed) || REPORTING_PRAGMA.test(trimmed);
}

function mutates(sql) {
  return splitStatements(sql).some(statement => !isReadOnly(statement));
}

function withoutSkippedPragmas(sql) {
  return splitStatements(sql).filter(statement => !SKIPPED_PRAGMA.test(statement.trim())).join(';');
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
  constructor(db, filename, SQL) {
    this.db = db;
    this.filename = filename;
    this.SQL = SQL || null;
    this.persistTimer = null;
    this.closed = false;
    this._inTransaction = false;
    this._txToken = null;
    this._lastMtimeMs = 0;
    this._updateMtime();
  }

  getLockPath() {
    return `${this.filename}.db-lock`;
  }

  _updateMtime() {
    if (this.filename === ':memory:') return;
    try {
      if (fs.existsSync(this.filename)) {
        this._lastMtimeMs = fs.statSync(this.filename).mtimeMs;
      }
    } catch (_) { /* ignore stat error */ }
  }

  reloadFromDisk() {
    if (this.filename === ':memory:' || !this.SQL) return;
    if (fs.existsSync(this.filename)) {
      assertNoPendingWal(this.filename);
      const data = new Uint8Array(fs.readFileSync(this.filename));
      if (this.db) {
        try { this.db.close(); } catch (_) { /* ignore close error */ }
      }
      this.db = new this.SQL.Database(data);
      this._updateMtime();
    }
  }

  async withWriteLock(fn) {
    if (this.filename === ':memory:') {
      return fn();
    }
    const mutex = getFileMutex(this.filename);
    await mutex.acquire();
    let token = null;
    try {
      token = await acquireFileLock(this.getLockPath());
      this.reloadFromDisk();
      const result = await fn();
      this.persistNow();
      return result;
    } catch (err) {
      try { this.reloadFromDisk(); } catch (_) { /* ignore reload error */ }
      throw err;
    } finally {
      if (token) {
        try { releaseFileLock(this.getLockPath(), token); } catch (_) {}
      }
      mutex.release();
    }
  }

  async run(sql, ...params) {
    const execute = () => {
      this.db.run(sql, normalizeParams(params));
      const changes = this.db.getRowsModified();
      const statement = this.db.prepare('SELECT last_insert_rowid() AS id');
      let lastID = 0;
      try {
        if (statement.step()) {
          const row = statement.getAsObject();
          lastID = Number(row?.id ?? 0);
        }
      } finally {
        statement.free();
      }
      return { lastID, changes };
    };

    if (!mutates(sql)) {
      return execute();
    }

    if (this._inTransaction) {
      return execute();
    }

    return this.withWriteLock(execute);
  }

  async get(sql, ...params) {
    const rows = await this.all(sql, ...params);
    return rows[0];
  }

  async all(sql, ...params) {
    if (this.filename !== ':memory:' && !this._inTransaction && fs.existsSync(this.filename)) {
      try {
        const currentMtime = fs.statSync(this.filename).mtimeMs;
        if (currentMtime !== this._lastMtimeMs) {
          this.reloadFromDisk();
        }
      } catch (_) { /* ignore stat error */ }
    }
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

  async exec(sql) {
    const text = withoutSkippedPragmas(sql);
    if (!text.trim()) return;

    if (!mutates(sql)) {
      this.db.exec(text);
      return;
    }

    const stripComments = (s) => s.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const rawPieces = splitStatements(text).map(s => s.trim()).filter(Boolean);
    const pieces = rawPieces.filter(s => stripComments(s) !== '');
    if (pieces.length === 0) {
      if (rawPieces.length > 0) this.db.exec(text);
      return;
    }

    const isBeginStmt = (s) => /^\s*BEGIN\b/i.test(stripComments(s));
    const isCommitStmt = (s) => /^\s*(COMMIT|END TRANSACTION|END)\b/i.test(stripComments(s));
    const isRollbackStmt = (s) => /^\s*ROLLBACK\b/i.test(stripComments(s));

    const firstStmt = pieces[0];
    const lastStmt = pieces[pieces.length - 1];

    const isBeginFirst = isBeginStmt(firstStmt);
    const hasCommitOrRollback = pieces.some(s => isCommitStmt(s) || isRollbackStmt(s));
    const isCommitLast = isCommitStmt(lastStmt);
    const isRollbackLast = isRollbackStmt(lastStmt);

    // Case 1: Standalone complete transaction block (e.g. BEGIN; ...; COMMIT/ROLLBACK;)
    if (isBeginFirst && (isCommitLast || isRollbackLast) && !this._inTransaction) {
      return this.withWriteLock(() => {
        this.db.exec(text);
      });
    }

    // Case 2: Opening a multi-statement transaction (BEGIN without matching COMMIT/ROLLBACK in same script)
    if (isBeginFirst && !hasCommitOrRollback && !this._inTransaction) {
      if (this.filename !== ':memory:') {
        const mutex = getFileMutex(this.filename);
        await mutex.acquire();
        let token = null;
        try {
          token = await acquireFileLock(this.getLockPath());
          this.reloadFromDisk();
          this.db.exec(text);
          this._txToken = token;
          this._inTransaction = true;
          return;
        } catch (err) {
          if (token) {
            try { releaseFileLock(this.getLockPath(), token); } catch (_) {}
          }
          mutex.release();
          this._txToken = null;
          this._inTransaction = false;
          throw err;
        }
      }
      this._inTransaction = true;
      try {
        this.db.exec(text);
      } catch (err) {
        this._inTransaction = false;
        throw err;
      }
      return;
    }

    // Case 3: Committing an open transaction
    if (isCommitLast && this._inTransaction) {
      try {
        this.db.exec(text);
        this.persistNow();
      } finally {
        this._exitTransaction();
      }
      return;
    }

    // Case 4: Rolling back an open transaction
    if (isRollbackLast && this._inTransaction) {
      try {
        this.db.exec(text);
      } finally {
        try { this.reloadFromDisk(); } catch (_) { /* ignore reload error */ }
        this._exitTransaction();
      }
      return;
    }

    // Case 5: Statements inside an ongoing transaction
    if (this._inTransaction) {
      this.db.exec(text);
      return;
    }

    // Case 6: Non-transactional mutating script outside of a transaction
    return this.withWriteLock(() => {
      this.db.exec(text);
    });
  }

  _exitTransaction() {
    if (this.filename !== ':memory:') {
      if (this._txToken) {
        releaseFileLock(this.getLockPath(), this._txToken);
        this._txToken = null;
      }
      const mutex = getFileMutex(this.filename);
      mutex.release();
    }
    this._inTransaction = false;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const wasInTransaction = this._inTransaction;
    if (wasInTransaction) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* ignore rollback error on close */ }
      this._exitTransaction();
    }
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    // Every committed mutation is already persisted under the file lock.
    // Persisting here without the lock would overwrite concurrent writers.
    if (this.db) {
      try { this.db.close(); } catch (_) { /* ignore close error */ }
      this.db = null;
    }
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
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
    if (this.filename === ':memory:' || !this.db) return;
    const dir = path.dirname(this.filename);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, Buffer.from(this.db.export()));
      fs.renameSync(tmp, this.filename);
      this._updateMtime();
    } finally {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (_) { /* ignore unlink error */ }
    }
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
    if (error?.code === 'ENOENT') return;
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
  const wasm = new WasmDatabase(new SQL.Database(data), filename, SQL);
  wasm._exitHandler = () => { void wasm.close(); };
  process.once('exit', wasm._exitHandler);
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
      if (filename !== ':memory:') {
        await db.exec('PRAGMA busy_timeout = 5000;');
        await db.exec('PRAGMA journal_mode = WAL;');
        await db.exec('PRAGMA synchronous = NORMAL;');
      }
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

module.exports = { openCompatDatabase, selectedEngine, isNativeLoadFailure, normalizeParams, mutates, splitStatements, WasmDatabase, acquireFileLock, releaseFileLock, isProcessAlive };
