'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
    const stmt = this._adapter._db.prepare(this._sql);
    const rows = [];
    try {
      if (params !== undefined) stmt.bind(params);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }

  get(...args) {
    const rows = this.all(...args);
    return rows.length > 0 ? rows[0] : undefined;
  }

  run(params) {
    const normalized = normalizeParams(params);
    const stmt = this._adapter._db.prepare(this._sql);
    try {
      if (normalized !== undefined) stmt.bind(normalized);
      stmt.step();
    } finally {
      stmt.free();
    }
    if (!this._adapter._inTransaction) this._adapter._persist();
  }
}

class SqlJsDatabase {
  constructor(sqlJs, dbPath, fileData) {
    this._path = dbPath;
    this._inTransaction = false;
    this._supportsWal = false;
    this._db = new sqlJs.Database(fileData || null);
    this._persistTimeout = null;
    this._initialPersistDone = false;
  }

  pragma(str) {
    const normalized = str.toLowerCase().replace(/\s+/g, '');
    if (normalized.includes('=')) {
      if (normalized.startsWith('journal_mode=')) return;
      this._db.run(`PRAGMA ${str}`);
      return;
    }
    if (normalized === 'journal_mode') return [{ journal_mode: 'memory' }];
    const stmt = this._db.prepare(`PRAGMA ${str}`);
    const rows = [];
    try {
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }

  exec(sql) {
    this._db.run(sql);
    if (!this._inTransaction) this._persist();
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  transaction(fn) {
    return (...args) => {
      this._db.run('BEGIN');
      this._inTransaction = true;
      try {
        const result = fn(...args);
        this._db.run('COMMIT');
        this._inTransaction = false;
        this._persist();
        return result;
      } catch (err) {
        try { this._db.run('ROLLBACK'); } catch (_) { /* rollback is best-effort */ } // NOSONAR
        this._inTransaction = false;
        throw err;
      }
    };
  }

  close() {
    if (!this._db) return;
    if (this._persistTimeout) {
      clearTimeout(this._persistTimeout);
      this._persistTimeout = null;
    }
    try {
      this._flushPersist();
    } catch (_) { // NOSONAR
      // ignore: persist errors on close are safely swallowed to prevent masking original errors
    } finally {
      try { this._db.close(); } catch (_) { /* ignore: close errors are safely swallowed during shutdown */ } // NOSONAR
      this._db = null;
    }
  }

  // PERF-01: coalesce bursts of writes into a single disk write instead of
  // re-serializing and rewriting the whole DB on every exec()/transaction().
  // The very first persist still happens synchronously so the DB file exists
  // on disk immediately after the first write, before any close()/flush().
  _persist() {
    if (this._path === ':memory:') return;
    if (!this._initialPersistDone) {
      this._initialPersistDone = true;
      this._flushPersist();
      return;
    }
    if (this._persistTimeout) {
      clearTimeout(this._persistTimeout);
    }
    this._persistTimeout = setTimeout(() => {
      this._persistTimeout = null;
      try {
        this._flushPersist();
      } catch (_) { // NOSONAR
        // ignore: _flushPersist already logs the failure. Swallowing it here keeps a failed debounced write from crashing the process inside a setTimeout callback
      }
    }, 50);
  }

  async flush() {
    if (this._persistTimeout) {
      clearTimeout(this._persistTimeout);
      this._persistTimeout = null;
    }
    this._flushPersist();
  }

  _flushPersist() {
    if (this._path === ':memory:' || !this._db) return;
    try {
      const data = this._db.export();
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      fs.writeFileSync(this._path, Buffer.from(data));
    } catch (e) {
      console.error(`[StateStoreDbAdapter] Failed to persist state to ${this._path}: ${e.message}`);
      throw e;
    }
  }
}

async function openDatabase(dbPath) {
  const SQL = await getSqlJs();
  let fileData;
  if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    fileData = fs.readFileSync(dbPath);
  }
  return new SqlJsDatabase(SQL, dbPath, fileData);
}

module.exports = { openDatabase };
