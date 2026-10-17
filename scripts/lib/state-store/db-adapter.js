'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireFileLockSync, releaseFileLock, assertNoPendingWal, mutates } = require('./sqlite-compat');

// PERF-01: a burst of writes reaches the disk as one file write.
const PERSIST_DEBOUNCE_MS = 50;
const DEFAULT_LOCK_TIMEOUT_MS = 15000;

let _SQL = null;

async function getSqlJs() {
  if (_SQL) return _SQL;
  const initSqlJs = require('sql.js');
  _SQL = await initSqlJs();
  return _SQL;
}

function normalizeParams(params) {
  if (params === null || params === undefined) return undefined;
  if (Array.isArray(params)) return params;
  if (typeof params === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(params)) {
      out[`@${k}`] = v === undefined ? null : v;
    }
    return out;
  }
  return [params];
}

// The file-backed adapters still open in this process. One exit handler
// writes what a process left debounced and releases the lock it holds, so a
// CLI that ends with process.exit() loses no row and leaves no lock behind.
const openAdapters = new Set();
let exitHandlerRegistered = false;

function registerExitHandlerOnce() {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.once('exit', () => {
    for (const adapter of openAdapters) adapter._settleAtExit();
  });
}

class Statement {
  constructor(adapter, sql) {
    this._adapter = adapter;
    this._sql = sql;
  }

  all(...args) {
    let params;
    if (args.length === 0) {
      params = undefined;
    } else if (args.length === 1) {
      params = normalizeParams(args[0]);
    } else {
      params = args;
    }
    return this._adapter._read(() => {
      const stmt = this._adapter._db.prepare(this._sql);
      const rows = [];
      try {
        if (params !== undefined) stmt.bind(params);
        while (stmt.step()) rows.push(stmt.getAsObject());
      } finally {
        stmt.free();
      }
      return rows;
    });
  }

  get(...args) {
    const rows = this.all(...args);
    return rows.length > 0 ? rows[0] : undefined;
  }

  run(params) {
    const normalized = normalizeParams(params);
    this._adapter._mutate(() => {
      const stmt = this._adapter._db.prepare(this._sql);
      try {
        if (normalized !== undefined) stmt.bind(normalized);
        stmt.step();
      } finally {
        stmt.free();
      }
    });
  }
}

// The CLI side of the state store: sql.js in memory, the file on disk. It
// shares the file with the hook writer and the MCP servers, which write
// through sqlite-compat.js, so it writes under the same <db>.db-lock: a
// mutation takes the lock, reloads the file when another process changed
// it, runs, and the persist that follows writes the file atomically and
// releases the lock. A read outside the lock reloads the file when it
// changed, so a row another process committed is seen without reopening.
class SqlJsDatabase {
  constructor(sqlJs, dbPath, options = {}) {
    this._sqlJs = sqlJs;
    this._path = dbPath;
    this._lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this._inTransaction = false;
    this._supportsWal = false;
    this._db = null;
    this._lockToken = null;
    this._dirty = false;
    this._pragmas = new Map();
    this._persistTimeout = null;
    this._initialPersistDone = false;
    this._lastMtimeMs = 0;
    this._lastIno = 0;
    this._loadFromDisk();
    if (this._isFileBacked()) {
      openAdapters.add(this);
      registerExitHandlerOnce();
    }
  }

  pragma(str) {
    this._assertOpen();
    const normalized = str.toLowerCase().replace(/\s+/g, '');
    if (normalized.includes('=')) {
      if (normalized.startsWith('journal_mode=')) return;
      // A connection setting: a new sql.js database starts from the
      // defaults, so it is replayed after every reload and export.
      this._pragmas.set(normalized.split('=')[0], str);
      this._db.run(`PRAGMA ${str}`);
      return;
    }
    if (normalized === 'journal_mode') return [{ journal_mode: 'memory' }];
    return this._read(() => {
      const stmt = this._db.prepare(`PRAGMA ${str}`);
      const rows = [];
      try {
        while (stmt.step()) rows.push(stmt.getAsObject());
      } finally {
        stmt.free();
      }
      return rows;
    });
  }

  exec(sql) {
    this._assertOpen();
    if (!mutates(sql)) {
      this._read(() => { this._db.run(sql); });
      return;
    }
    this._mutate(() => { this._db.run(sql); });
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  transaction(fn) {
    return (...args) => {
      this._assertOpen();
      this._acquireWriteLock();
      try {
        this._db.run('BEGIN');
        this._inTransaction = true;
        const result = fn(...args);
        this._db.run('COMMIT');
        this._inTransaction = false;
        this._dirty = true;
        this._persist();
        return result;
      } catch (err) {
        try { this._db.run('ROLLBACK'); } catch (_) { /* rollback is best-effort */ } // NOSONAR
        this._inTransaction = false;
        if (!this._dirty) this._releaseWriteLock();
        throw err;
      }
    };
  }

  close() {
    if (!this._db) return;
    this._clearPersistTimer();
    try {
      if (this._dirty) this._flushPersist();
    } catch (_) { // NOSONAR
      // ignore: persist errors on close are safely swallowed to prevent masking original errors
    } finally {
      this._releaseWriteLock();
      openAdapters.delete(this);
      try { this._db.close(); } catch (_) { /* ignore: close errors are safely swallowed during shutdown */ } // NOSONAR
      this._db = null;
    }
  }

  // Force any debounced write to disk now. Unlike close(), a persist
  // failure reaches the caller.
  async flush() {
    this._clearPersistTimer();
    if (this._dirty) {
      this._flushPersist();
      return;
    }
    this._releaseWriteLock();
  }

  _isFileBacked() {
    return this._path !== ':memory:';
  }

  _lockPath() {
    return `${this._path}.db-lock`;
  }

  _assertOpen() {
    if (!this._db) throw new Error(`[StateStoreDbAdapter] the database at ${this._path} is closed`);
  }

  // A read outside the lock first lands what another adapter of this process
  // still has debounced, then reloads the file when it changed, so what one
  // connection wrote is read by the next one in the same process.
  _read(fn) {
    this._assertOpen();
    if (!this._inTransaction && !this._lockToken) {
      const holder = this._inProcessHolder();
      if (holder && !holder._inTransaction) holder._flushPersist();
      this._reloadIfChanged();
    }
    return fn();
  }

  // A mutation outside a transaction runs with the lock held and the copy
  // in memory fresh. The lock stays held until the debounced persist writes
  // the file, so a burst of writes costs one lock and one file write and no
  // other writer gets between them.
  _mutate(fn) {
    this._assertOpen();
    if (this._inTransaction) return fn();
    this._acquireWriteLock();
    try {
      const result = fn();
      this._dirty = true;
      this._persist();
      return result;
    } catch (err) {
      if (!this._dirty) this._releaseWriteLock();
      throw err;
    }
  }

  // A second adapter on the same file in this process may hold the lock with
  // a debounced write pending; waiting on it would wait for a timer that
  // cannot fire while this call spins. Its write goes to disk now and the
  // lock passes on. A transaction it has open cannot be finished for it, so
  // that case is refused instead of deadlocking.
  _acquireWriteLock() {
    if (!this._isFileBacked() || this._lockToken) return;
    const holder = this._inProcessHolder();
    if (holder) {
      if (holder._inTransaction) {
        throw new Error(`[StateStoreDbAdapter] another connection in this process holds a transaction on ${this._path}`);
      }
      holder._flushPersist();
    }
    this._lockToken = acquireFileLockSync(this._lockPath(), { timeoutMs: this._lockTimeoutMs });
    try {
      this._reloadIfChanged();
    } catch (err) {
      this._releaseWriteLock();
      throw err;
    }
  }

  _inProcessHolder() {
    for (const other of openAdapters) {
      if (other !== this && other._path === this._path && other._lockToken) return other;
    }
    return null;
  }

  _releaseWriteLock() {
    if (!this._lockToken) return;
    const token = this._lockToken;
    this._lockToken = null;
    releaseFileLock(this._lockPath(), token);
  }

  // Loads the file as it is on disk in place of the copy in memory.
  _loadFromDisk() {
    let data = null;
    if (this._isFileBacked()) {
      assertNoPendingWal(this._path);
      if (fs.existsSync(this._path)) data = fs.readFileSync(this._path);
    }
    if (this._db) {
      try { this._db.close(); } catch (_) { /* the copy being replaced is discarded either way */ } // NOSONAR
    }
    this._db = new this._sqlJs.Database(data);
    this._replayPragmas();
    this._updateMtime();
  }

  _replayPragmas() {
    for (const pragma of this._pragmas.values()) this._db.run(`PRAGMA ${pragma}`);
  }

  _updateMtime() {
    if (!this._isFileBacked()) return;
    try {
      const stat = fs.statSync(this._path);
      this._lastMtimeMs = stat.mtimeMs;
      this._lastIno = stat.ino;
    } catch (_) { /* a file not written yet has no identity to track */ } // NOSONAR
  }

  // Every persist under the lock protocol renames a new inode over the file,
  // so a change by another process shows as a new inode or a new mtime.
  _reloadIfChanged() {
    if (!this._isFileBacked()) return;
    let stat;
    try {
      stat = fs.statSync(this._path);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (stat.mtimeMs !== this._lastMtimeMs || stat.ino !== this._lastIno) this._loadFromDisk();
  }

  _clearPersistTimer() {
    if (this._persistTimeout) {
      clearTimeout(this._persistTimeout);
      this._persistTimeout = null;
    }
  }

  // The very first persist still happens synchronously so the DB file exists
  // on disk immediately after the first write, before any close()/flush().
  _persist() {
    if (!this._isFileBacked()) return;
    if (!this._initialPersistDone) {
      this._initialPersistDone = true;
      this._flushPersist();
      return;
    }
    this._clearPersistTimer();
    this._persistTimeout = setTimeout(() => {
      this._persistTimeout = null;
      try {
        this._flushPersist();
      } catch (_) { // NOSONAR
        // ignore: _flushPersist already logs the failure. Swallowing it here keeps a failed debounced write from crashing the process inside a setTimeout callback
      }
    }, PERSIST_DEBOUNCE_MS);
  }

  // Writes the copy in memory over the file and releases the lock. When the
  // write fails the lock stays held: the file is behind this process, and no
  // other writer may overwrite what this one still has to write.
  _flushPersist() {
    this._clearPersistTimer();
    if (!this._isFileBacked() || !this._db) return;
    if (!this._dirty) {
      this._releaseWriteLock();
      return;
    }
    try {
      if (!this._lockToken) {
        this._lockToken = acquireFileLockSync(this._lockPath(), { timeoutMs: this._lockTimeoutMs });
      }
      this._writeFile();
      this._dirty = false;
    } catch (e) {
      console.error(`[StateStoreDbAdapter] Failed to persist state to ${this._path}: ${e.message}`);
      throw e;
    }
    this._releaseWriteLock();
  }

  // A temporary file renamed over the database, so a reader never sees a
  // half-written file. sql.js reopens its database on export, which drops
  // the connection pragmas, so they are replayed right after.
  _writeFile() {
    const data = this._db.export();
    this._replayPragmas();
    const dir = path.dirname(this._path);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this._path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, Buffer.from(data));
      fs.renameSync(tmp, this._path);
    } finally {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (_) { /* a leftover temporary file is harmless */ } // NOSONAR
    }
    this._updateMtime();
  }

  _settleAtExit() {
    try {
      if (this._dirty && this._db) this._flushPersist();
    } catch (_) { // NOSONAR
      // the flush already reported the failure; the exit goes on
    } finally {
      this._releaseWriteLock();
    }
  }
}

async function openDatabase(dbPath, options = {}) {
  const SQL = await getSqlJs();
  return new SqlJsDatabase(SQL, dbPath, options);
}

module.exports = { openDatabase };
