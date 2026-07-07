'use strict';

const fs = require('fs');
const path = require('path');

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
    const params = args.length === 0 ? undefined
      : args.length === 1 ? normalizeParams(args[0])
      : args;
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
        try { this._db.run('ROLLBACK'); } catch (_) { /* rollback is best-effort */ }
        this._inTransaction = false;
        throw err;
      }
    };
  }

  close() {
    if (!this._db) return;
    try {
      if (this._persistTimeout) {
        clearTimeout(this._persistTimeout);
        this._persistTimeout = null;
      }
      this._flushPersist();
    } catch (_) {
      // Ignore persist errors on close to prevent masking original errors
    } finally {
      try { this._db.close(); } catch (_) { /* ignore close errors */ }
      this._db = null;
    }
  }

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
      this._flushPersist();
    }, 50); // 50ms debounce
  }

  _flushPersist() {
    if (this._path === ':memory:' || !this._db) return;
    const data = this._db.export();
    fs.mkdirSync(path.dirname(this._path), { recursive: true });
    fs.writeFileSync(this._path, Buffer.from(data));
  }

  async flush() {
    if (this._persistTimeout) {
      clearTimeout(this._persistTimeout);
      this._persistTimeout = null;
    }
    this._flushPersist();
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
