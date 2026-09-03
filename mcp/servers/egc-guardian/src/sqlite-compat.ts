// Opens the SQLite database with the native sqlite3 driver and, when that
// driver cannot load on this machine, with the portable sql.js engine.
//
// The native binary published with sqlite3 6.x is built against a glibc
// newer than the one on Debian 12, Ubuntu 22.04 and similar hosts, and
// loading it fails with ERR_DLOPEN_FAILED. The CLI already survives that by
// falling back to sql.js (scripts/lib/state-store/db-adapter.js); the MCP
// servers used to crash at startup instead. This module gives them the same
// answer behind the async API the rest of the code already uses.
//
// EGC_SQLITE_ENGINE=native  never fall back (surface the native error)
// EGC_SQLITE_ENGINE=wasm    always use sql.js (used by the fallback tests)

import fs from 'node:fs';
import path from 'node:path';
import { open, Database } from 'sqlite';

type Param = string | number | null | Uint8Array | boolean | undefined;

interface SqlJsStatement {
  bind(params?: Param[] | Record<string, Param>): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): boolean;
}

interface SqlJsDatabase {
  prepare(sql: string): SqlJsStatement;
  run(sql: string, params?: Param[] | Record<string, Param>): SqlJsDatabase;
  exec(sql: string): unknown;
  getRowsModified(): number;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null;
let fallbackAnnounced = false;

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = import('sql.js').then(mod => (mod.default as unknown as () => Promise<SqlJsStatic>)());
  }
  return sqlJsPromise;
}

export function isNativeLoadFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'ERR_DLOPEN_FAILED' || code === 'MODULE_NOT_FOUND') return true;
  const message = String((error as { message?: unknown }).message || '');
  return /GLIBC|dlopen|bindings file|\.node'?:|invalid ELF header|not a valid Win32 application|Symbol not found/i.test(message);
}

function normalizeParams(params: unknown[]): Param[] | Record<string, Param> | undefined {
  if (params.length === 0) return undefined;
  if (params.length === 1) {
    const only = params[0];
    if (Array.isArray(only)) return only as Param[];
    if (only && typeof only === 'object' && !(only instanceof Uint8Array)) {
      const out: Record<string, Param> = {};
      for (const [key, value] of Object.entries(only as Record<string, Param>)) {
        out[key.startsWith('$') || key.startsWith(':') || key.startsWith('@') ? key : `$${key}`] = value === undefined ? null : value;
      }
      return out;
    }
    return [only as Param];
  }
  return params.map(value => (value === undefined ? null : value) as Param);
}

function isMutating(sql: string): boolean {
  return !/^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(sql);
}

// Async facade over sql.js matching the subset of the `sqlite` Database API
// the servers use: run, get, all, exec, close. Writes persist to the file
// after each mutating statement (debounced) and on close.
class WasmDatabase {
  private readonly db: SqlJsDatabase;
  private readonly filename: string;
  private persistTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(db: SqlJsDatabase, filename: string) {
    this.db = db;
    this.filename = filename;
  }

  async run(sql: string, ...params: unknown[]): Promise<{ lastID: number; changes: number }> {
    const bound = normalizeParams(params);
    this.db.run(sql, bound);
    const changes = this.db.getRowsModified();
    let lastID = 0;
    try {
      const row = this.db.prepare('SELECT last_insert_rowid() AS id');
      if (row.step()) lastID = Number(row.getAsObject().id || 0);
      row.free();
    } catch {
      lastID = 0;
    }
    if (isMutating(sql)) this.schedulePersist();
    return { lastID, changes };
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const rows = await this.all<T>(sql, ...params);
    return rows[0];
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const statement = this.db.prepare(sql);
    try {
      const bound = normalizeParams(params);
      if (bound) statement.bind(bound);
      const rows: T[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as T);
      return rows;
    } finally {
      statement.free();
    }
  }

  async exec(sql: string): Promise<void> {
    // sql.js has no WAL and no busy timeout; those pragmas are meaningful
    // only to the native engine, so they are skipped rather than failed.
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const statement of statements) {
      if (/^PRAGMA\s+(journal_mode|busy_timeout|synchronous)\b/i.test(statement)) continue;
      this.db.exec(statement);
    }
    if (isMutating(sql)) this.schedulePersist();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.persistNow();
    this.db.close();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 25);
    this.persistTimer.unref();
  }

  private persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.filename === ':memory:') return;
    const data = Buffer.from(this.db.export());
    const tmp = `${this.filename}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.filename);
  }
}

async function openWasmDatabase(filename: string): Promise<Database> {
  const SQL = await loadSqlJs();
  let data: Uint8Array | undefined;
  if (filename !== ':memory:' && fs.existsSync(filename)) {
    data = new Uint8Array(fs.readFileSync(filename));
  }
  const wasm = new WasmDatabase(new SQL.Database(data), filename);
  const flush = () => { void wasm.close(); };
  process.once('exit', flush);
  return wasm as unknown as Database;
}

function announceFallback(serverName: string, error: unknown): void {
  if (fallbackAnnounced) return;
  fallbackAnnounced = true;
  const reason = String((error as { message?: unknown })?.message || error).split('\n')[0];
  process.stderr.write(`[${serverName}] native sqlite3 unavailable (${reason}); using the portable sql.js engine. Cross-process locking is reduced on this machine.\n`);
}

export async function openCompatDatabase(filename: string, serverName: string): Promise<Database> {
  const engine = process.env.EGC_SQLITE_ENGINE;
  if (engine !== 'wasm') {
    try {
      const sqlite3 = (await import('sqlite3')).default;
      return await open({ filename, driver: sqlite3.Database });
    } catch (error) {
      if (engine === 'native' || !isNativeLoadFailure(error)) throw error;
      announceFallback(serverName, error);
    }
  }
  return openWasmDatabase(filename);
}
