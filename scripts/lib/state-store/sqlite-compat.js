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
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');

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
  if (!token || typeof token !== 'string') return false;
  try {
    if (!fs.existsSync(lockPath)) return true;
    const raw = fs.readFileSync(lockPath, 'utf8');
    const data = JSON.parse(raw);
    if (data?.token === token) {
      fs.unlinkSync(lockPath);
      return true;
    }
    // Lock file exists but belongs to a different token/owner
    return true;
  } catch (err) {
    return err?.code === 'ENOENT';
  }
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
    // If another application listener is registered, it controls the process lifecycle
    // (e.g. graceful shutdown, drain, or ignoring the signal).
    // Releasing locks here while the process might continue writing would cause concurrency hazards.
    // Furthermore, we do NOT re-raise the signal if other listeners exist, because doing so would
    // invoke those application listeners a second time. We leave our listener registered so that
    // subsequent signals are handled safely.
    // If no other listener exists, default signal termination should occur:
    // clean up our owned locks, remove our listener, and re-raise the signal.
    if (process.listenerCount(signal) > 1) {
      return;
    }
    cleanupHeldLocks();
    process.removeListener(signal, signalHandlers[signal]);
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
    if (err?.code === 'EEXIST') return false;
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
  const unlinked = unlinkLockIfOwned(lockPath, token);
  if (unlinked) {
    heldLocks.delete(lockPath);
  }
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

async function pollLockUntilAcquired(lockPath, token, deadline, retryIntervalMs) {
  let lastHolder = null;
  while (Date.now() < deadline) {
    if (tryAcquireLockOnce(lockPath, token)) {
      heldLocks.set(lockPath, token);
      return { token, lastHolder: null };
    }

    const holder = readLockHolder(lockPath);
    if (holder) {
      lastHolder = holder;
      checkDeadProcessHolder(holder, lockPath);
    }

    await delayWithJitter(retryIntervalMs); // NOSONAR: intentional async polling delay between lock retries
  }
  return { token: null, lastHolder };
}

async function acquireFileLock(lockPath, { timeoutMs = 15000, retryIntervalMs = 25 } = {}) {
  registerSignalHandlersOnce();
  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  const result = await pollLockUntilAcquired(lockPath, token, deadline, retryIntervalMs);
  if (result.token) {
    return result.token;
  }

  const lastHolder = result.lastHolder;
  const hostInfo = (lastHolder?.hostname && lastHolder.hostname !== os.hostname()) ? ` on host ${lastHolder.hostname}` : '';
  const holderInfo = lastHolder ? ` (held by PID ${lastHolder.pid}${hostInfo}, token ${lastHolder.token})` : '';
  throw new Error(`[sqlite-compat] Lock timeout after ${timeoutMs}ms acquiring ${lockPath}${holderInfo}`);
}

function errorMessage(error) {
  if (error instanceof Error) return error.message.split('\n')[0];
  return String(error).split('\n')[0];
}

// Both engines resolve from the package root, because the servers load this
// file from there and not from their own folder. A checkout whose servers
// were built without the root dependencies has neither engine, and a bare
// "Cannot find module" does not say where to install.

function missingEnginesError(nativeError, cause) {
  const native = nativeError ? ` sqlite3 did not load either: ${errorMessage(nativeError)}.` : '';
  return new Error(`sql.js is not installed under ${PACKAGE_ROOT}, where EGC loads its SQLite engines from.${native} In a git checkout run "npm ci" in that directory; in an npm install, reinstall @egchq/egc.`, { cause });
}

function loadSqlJs(nativeError) {
  if (!sqlJsPromise) {
    let initSqlJs;
    try {
      initSqlJs = require('sql.js');
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
      throw missingEnginesError(nativeError, error);
    }
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

function consumeQuotedLiteral(sql, start, len) {
  const q = sql[start];
  let res = q;
  let i = start + 1;
  while (i < len && sql[i] !== q) {
    res += sql[i];
    i += 1;
  }
  if (i < len) {
    res += sql[i];
    i += 1;
  }
  return { text: res, nextIndex: i };
}

function skipComment(sql, start) {
  if (sql[start] === '-' && sql[start + 1] === '-') {
    const nl = sql.indexOf('\n', start + 2);
    return nl === -1 ? sql.length : nl + 1;
  }
  if (sql[start] === '/' && sql[start + 1] === '*') {
    const end = sql.indexOf('*/', start + 2);
    return end === -1 ? sql.length : end + 2;
  }
  return -1;
}

function stripSqlComments(sql) {
  let res = '';
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const nextComment = skipComment(sql, i);
    if (nextComment !== -1) {
      if (nextComment >= len) break;
      i = nextComment;
    } else if (sql[i] === '\'' || sql[i] === '"') {
      const quoted = consumeQuotedLiteral(sql, i, len);
      res += quoted.text;
      i = quoted.nextIndex;
    } else {
      res += sql[i];
      i += 1;
    }
  }
  return res.replace(/\s+/g, ' ').trim();
}

function isBeginStatement(clean) {
  return /^BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?$/i.test(clean);
}

function isCommitStatement(clean) {
  return /^(?:COMMIT|END)(?:\s+(?:TRANSACTION|WORK))?$/i.test(clean);
}

function isRollbackStatement(clean) {
  return /^ROLLBACK(?:\s+(?:TRANSACTION|WORK))?$/i.test(clean);
}

function parseTransactionBounds(pieces) {
  const isBeginStmt = (s) => isBeginStatement(stripSqlComments(s));
  const isCommitStmt = (s) => isCommitStatement(stripSqlComments(s));
  const isRollbackStmt = (s) => isRollbackStatement(stripSqlComments(s));

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
  constructor(db, filename, SQL, options = {}) {
    this.db = db;
    this.filename = filename;
    this.SQL = SQL || null;
    this.options = options;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 15000;
    this.persistTimer = null;
    this.closed = false;
    this._inTransaction = false;
    this._txToken = null;
    this._lastMtimeMs = 0;
    this._lastIno = 0;
    this._updateMtime();
  }

  getLockPath() {
    return `${this.filename}.db-lock`;
  }

  _updateMtime() {
    if (this.filename === ':memory:') return;
    try {
      if (fs.existsSync(this.filename)) {
        const stat = fs.statSync(this.filename);
        this._lastMtimeMs = stat.mtimeMs;
        this._lastIno = stat.ino;
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
      token = await acquireFileLock(this.getLockPath(), { timeoutMs: this.lockTimeoutMs });
      this.reloadFromDisk();
      const maybePromise = fn();
      let result;
      if (maybePromise && typeof maybePromise.then === 'function') {
        result = await maybePromise;
      } else {
        result = maybePromise;
      }
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
        const currentStat = fs.statSync(this.filename);
        const identityUnknown = !currentStat.ino || !this._lastIno;
        if (
          identityUnknown ||
          currentStat.mtimeMs !== this._lastMtimeMs ||
          currentStat.ino !== this._lastIno
        ) {
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
        token = await acquireFileLock(this.getLockPath(), { timeoutMs: this.lockTimeoutMs });
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

// The engine is loaded before the write-ahead log is checked: with no engine
// installed, the log advice (open the file with a working native sqlite3)
// would point away from the real cause.
async function openWasmDatabase(filename, nativeError, options = {}) {
  const SQL = await loadSqlJs(nativeError);
  const reader = options.reader === true;
  assertNoPendingWal(filename);
  const data = filename !== ':memory:' && fs.existsSync(filename)
    ? new Uint8Array(fs.readFileSync(filename))
    : undefined;
  // A reader gets the rows with no file behind them: close() then has
  // nothing to write back, and there is nothing to flush at exit.
  if (reader) return new WasmDatabase(new SQL.Database(data), ':memory:', SQL, options);
  const wasm = new WasmDatabase(new SQL.Database(data), filename, SQL, options);
  wasm._exitHandler = () => { void wasm.close(); };
  process.once('exit', wasm._exitHandler);
  return wasm;
}

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

module.exports = { openCompatDatabase, selectedEngine, isNativeLoadFailure, normalizeParams, mutates, splitStatements, WasmDatabase, acquireFileLock, releaseFileLock, isProcessAlive };
