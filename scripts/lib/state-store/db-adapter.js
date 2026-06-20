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
    this._db = new sqlJs.Database(fileData || null);
  }

  pragma(str) {
    if (str.toLowerCase().includes('journal_mode')) return;
    this._db.run(`PRAGMA ${str}`);
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
        try { this._db.run('ROLLBACK'); } catch (_) {}
        this._inTransaction = false;
        throw err;
      }
    };
  }

  close() {
    this._persist();
    this._db.close();
  }

  _persist() {
    if (this._path === ':memory:') return;
    const data = this._db.export();
    fs.mkdirSync(path.dirname(this._path), { recursive: true });
    fs.writeFileSync(this._path, Buffer.from(data));
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
