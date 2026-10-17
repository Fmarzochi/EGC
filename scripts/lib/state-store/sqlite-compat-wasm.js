'use strict';

// The portable sql.js engine behind the same async API as the native driver
// (run, get, all, exec, close): the whole file is held in memory, every
// write happens under the file lock and is persisted by a rename over the
// file, and the copy is reloaded whenever the file changed underneath.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getFileMutex, acquireFileLock, releaseFileLock, renameOverSync, readFileWithIdentity } = require('./sqlite-compat-lock');
const { splitStatements, mutates, withoutSkippedPragmas, normalizeParams, stripSqlComments, parseTransactionBounds } = require('./sqlite-compat-sql');

const NATIVE_FAILURE_MESSAGE = /GLIBC|dlopen|bindings file|\.node'?:|invalid ELF header|not a valid Win32 application|Symbol not found/i;
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');

let sqlJsPromise = null;

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
    // The identity of the bytes `db` was built from, when the caller read
    // them through readFileWithIdentity; a stat of the path would otherwise
    // be taken now, after the read, with the window described there.
    if (options.identity) {
      this._lastMtimeMs = options.identity.mtimeMs;
      this._lastIno = options.identity.ino;
    } else {
      this._updateMtime();
    }
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
    if (fs.existsSync(this.filename)) assertNoPendingWal(this.filename);
    const read = readFileWithIdentity(this.filename);
    if (this.db) {
      try { this.db.close(); } catch (_) { /* ignore close error */ }
    }
    this.db = read.data ? new this.SQL.Database(new Uint8Array(read.data)) : new this.SQL.Database();
    this._lastMtimeMs = read.mtimeMs;
    this._lastIno = read.ino;
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
      renameOverSync(tmp, this.filename);
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
  const read = filename === ':memory:' ? { data: null, mtimeMs: 0, ino: 0 } : readFileWithIdentity(filename);
  const data = read.data ? new Uint8Array(read.data) : undefined;
  // A reader gets the rows with no file behind them: close() then has
  // nothing to write back, and there is nothing to flush at exit.
  if (reader) return new WasmDatabase(new SQL.Database(data), ':memory:', SQL, options);
  const wasm = new WasmDatabase(new SQL.Database(data), filename, SQL, { ...options, identity: read });
  wasm._exitHandler = () => { void wasm.close(); };
  process.once('exit', wasm._exitHandler);
  return wasm;
}

module.exports = { errorMessage, isNativeLoadFailure, WasmDatabase, assertNoPendingWal, openWasmDatabase };
