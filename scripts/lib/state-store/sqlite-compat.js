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

// Process-level map tracking lock paths and tokens currently held by this process.
const heldLocks = new Map();
let signalHandlersRegistered = false;

function unlinkLockIfOwned(lockPath, token) {
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

function cleanupHeldLocks() {
  for (const [lockPath, token] of heldLocks.entries()) {
    unlinkLockIfOwned(lockPath, token);
  }
  heldLocks.clear();
}

function registerSignalHandlersOnce() {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;

  // Process exit is the definitive lifecycle hook where process-held locks must be cleaned up.
  process.once('exit', () => {
    cleanupHeldLocks();
  });

  const handleSignal = (signal) => {
    // If another application listener is registered, it might keep the process alive
    // or perform graceful shutdown. Releasing locks here while the process might continue
    // writing would cause concurrency hazards. Instead, if no other listener prevents default
    // termination, removing our listener and re-killing triggers standard process exit,
    // which then invokes process 'exit' handler to safely clean up held locks.
    process.removeListener(signal, signalHandlers[signal]);
    if (process.listenerCount(signal) === 0) {
      cleanupHeldLocks();
    }
    process.kill(process.pid, signal);
  };

  const signalHandlers = {
    SIGINT: () => handleSignal('SIGINT'),
    SIGTERM: () => handleSignal('SIGTERM'),
  };

  process.on('SIGINT', signalHandlers.SIGINT);
  process.on('SIGTERM', signalHandlers.SIGTERM);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

function checkSameInodeOrEmpty(fd, lockPath) {
  try {
    const fstat = fs.fstatSync(fd);
    const stat = fs.statSync(lockPath);
    return (fstat.ino && stat.ino) ? fstat.ino === stat.ino : stat.size === 0;
  } catch (statErr) {
    if (statErr.code !== 'ENOENT') {
      process.stderr.write(`[sqlite-compat] stat verification failed for ${lockPath}: ${statErr.message}\n`);
    }
    return false;
  }
}

function cleanupFailedLockWrite(fd, lockPath) {
  let isOurFile;
  try {
    isOurFile = checkSameInodeOrEmpty(fd, lockPath);
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore close error */ }
  }
  if (isOurFile) {
    try { fs.unlinkSync(lockPath); } catch (_) { /* ignore unlink error */ }
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
    cleanupFailedLockWrite(fd, lockPath);
    fd = undefined;
    throw writeErr;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* ignore close error */ }
    }
  }
}

function releaseFileLock(lockPath, token) {
  if (!token || typeof token !== 'string') return;
  heldLocks.delete(lockPath);
  unlinkLockIfOwned(lockPath, token);
}

function checkDeadProcessHolder(holder, lockPath) {
  if (!holder) return;
  const sameHost = holder.hostname === os.hostname();
  const isValidPid = Number.isInteger(holder.pid) && holder.pid > 0;
  const isDeadLocalPid = sameHost && isValidPid && !isProcessAlive(holder.pid);
  if (isDeadLocalPid) {
    const currentHolder = readLockHolder(lockPath);
    if (currentHolder && currentHolder.token === holder.token && currentHolder.pid === holder.pid) {
      throw new Error(
        `[sqlite-compat] Lock file "${lockPath}" is held by dead process PID ${holder.pid} on host ${holder.hostname}. ` +
        `Automatic stale-lock recovery is disabled to ensure strict mutual exclusion. ` +
        `To recover manually, verify that process ${holder.pid} is not running, then remove the lock file: rm "${lockPath}"`
      );
    }
  }
}

function readLockHolder(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    if (raw.trim()) {
      return JSON.parse(raw);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Malformed JSON or transient read error: fail closed by returning null to keep waiting
    }
  }
  return null;
}

function delayWithJitter(retryIntervalMs) {
  const jitter = crypto.randomInt(0, 20);
  return new Promise(r => setTimeout(r, retryIntervalMs + jitter));
}

async function acquireFileLock(lockPath, { timeoutMs = 15000, retryIntervalMs = 25 } = {}) {
  registerSignalHandlersOnce();
  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  let lastHolder = null;

  while (Date.now() < deadline) {
    if (tryAcquireLockOnce(lockPath, token)) {
      heldLocks.set(lockPath, token);
      return token;
    }

    const holder = readLockHolder(lockPath);
    if (holder) {
      lastHolder = holder;
      checkDeadProcessHolder(holder, lockPath);
    }

    await delayWithJitter(retryIntervalMs);
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

const SQL_COMMENT_LINE = /--.*$/gm;
const SQL_COMMENT_BLOCK = /\/\*[\s\S]*?\*\//g;
const BEGIN_STMT_REGEX = /^\s*BEGIN\b(?!\s+(?:AFTER|BEFORE|INSTEAD\s+OF)\b)/i;
const COMMIT_STMT_REGEX = /^\s*(?:COMMIT(?:\s+TRANSACTION|\s+WORK)?|END\s+TRANSACTION|END(?!\s+(?:IF|FOR|WHILE|CASE|LOOP)\b))\s*$/i;
const ROLLBACK_STMT_REGEX = /^\s*ROLLBACK(?:\s+TRANSACTION|\s+WORK)?(?!\s+TO\b)\s*$/i;

function stripSqlComments(s) {
  return s.replace(SQL_COMMENT_LINE, '').replace(SQL_COMMENT_BLOCK, '').trim();
}

function parseTransactionBounds(pieces) {
  const isBeginStmt = (s) => BEGIN_STMT_REGEX.test(stripSqlComments(s));
  const isCommitStmt = (s) => COMMIT_STMT_REGEX.test(stripSqlComments(s));
  const isRollbackStmt = (s) => ROLLBACK_STMT_REGEX.test(stripSqlComments(s));

  const firstStmt = pieces[0];
  const lastStmt = pieces[pieces.length - 1];

  return {
    isBeginFirst: isBeginStmt(firstStmt),
    hasCommitOrRollback: pieces.some(s => isCommitStmt(s) || isRollbackStmt(s)),
    isCommitLast: isCommitStmt(lastStmt),
    isRollbackLast: isRollbackStmt(lastStmt),
  };
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
    } else {
      if (this.db) {
        try { this.db.close(); } catch (_) { /* ignore close error */ }
      }
      this.db = new this.SQL.Database();
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
        try { releaseFileLock(this.getLockPath(), token); } catch (_) { /* ignore release error */ }
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

  async _beginTransaction(text) {
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
          try { releaseFileLock(this.getLockPath(), token); } catch (_) { /* ignore release error */ }
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
  }

  _commitTransaction(text) {
    try {
      this.db.exec(text);
      this.persistNow();
    } catch (err) {
      try { this.reloadFromDisk(); } catch (_) { /* ignore reload error */ }
      throw err;
    } finally {
      this._exitTransaction();
    }
  }

  _rollbackTransaction(text) {
    try {
      this.db.exec(text);
    } finally {
      try { this.reloadFromDisk(); } catch (_) { /* ignore reload error */ }
      this._exitTransaction();
    }
  }

  _dispatchTransactionalExec(text, bounds) {
    const { isBeginFirst, hasCommitOrRollback, isCommitLast, isRollbackLast } = bounds;

    if (isBeginFirst && (isCommitLast || isRollbackLast) && !this._inTransaction) {
      return this.withWriteLock(() => {
        this.db.exec(text);
      });
    }

    if (isBeginFirst && !hasCommitOrRollback && !this._inTransaction) {
      return this._beginTransaction(text);
    }

    if (isCommitLast && this._inTransaction) {
      return this._commitTransaction(text);
    }

    if (isRollbackLast && this._inTransaction) {
      return this._rollbackTransaction(text);
    }

    if (this._inTransaction) {
      this.db.exec(text);
      return;
    }

    return this.withWriteLock(() => {
      this.db.exec(text);
    });
  }

  async exec(sql) {
    const text = withoutSkippedPragmas(sql);
    if (!text.trim()) return;

    if (!mutates(sql)) {
      this.db.exec(text);
      return;
    }

    const rawPieces = splitStatements(text).map(s => s.trim()).filter(Boolean);
    const pieces = rawPieces.filter(s => stripSqlComments(s) !== '');
    if (pieces.length === 0) {
      if (rawPieces.length > 0) this.db.exec(text);
      return;
    }

    const bounds = parseTransactionBounds(pieces);
    return this._dispatchTransactionalExec(text, bounds);
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

// A write-ahead log (-wal) or shared memory index (-shm) left behind by a
// native engine (a crash, or an active connection still open elsewhere) indicates
// active WAL-mode state or uncheckpointed rows that only the native engine can read.
// Opening the main file with the portable WASM engine while these exist would risk
// split-brain divergence or silently dropping uncheckpointed changes.
//
// Limitations:
// If the native SQLite engine is running with a rollback journal (DELETE/PERSIST/TRUNCATE mode)
// rather than WAL mode, or has not yet written a -wal/-shm sidecar, sidecar detection cannot
// detect the active connection without OS-level file locking. Therefore, the single-engine
// rule remains fundamental: a database file should never be accessed concurrently by different engines.
function assertNoPendingSidecars(filename) {
  if (filename === ':memory:') return;
  const sidecars = [
    { ext: '-wal', label: 'write-ahead data' },
    { ext: '-shm', label: 'shared-memory index data' },
  ];

  for (const { ext, label } of sidecars) {
    const sidecarPath = `${filename}${ext}`;
    let size;
    try {
      size = fs.statSync(sidecarPath).size;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (size > 0) {
      throw new Error(
        `${sidecarPath} holds ${size} bytes of ${label} that the portable engine cannot read; ` +
        `open the database once with a working native sqlite3 so it is checkpointed, or restore a clean copy, before using the portable engine.`
      );
    }
  }
}

function assertNoPendingWal(filename) {
  assertNoPendingSidecars(filename);
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
