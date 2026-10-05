import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'sqlite';
import type { ExtractResult, ImportBinding } from './graph-extract.js';
import { openCompatDatabase } from './sqlite-compat.js';

export const GRAPH_SCHEMA_VERSION = 1;

export interface FileRow { path: string; mtimeMs: number; size: number; hash: string }
export interface SymbolRow { id: number; file: string; name: string; kind: string; exported: boolean; startLine: number; endLine: number; refs: string[] }
export interface ImportRow { file: string; specifier: string; bindings: ImportBinding[]; reexport: boolean }
export interface EdgeRow { src: string; dst: string; kind: 'import' | 'ref' }
export interface GraphData { files: FileRow[]; symbols: SymbolRow[]; imports: ImportRow[]; edges: EdgeRow[] }

export interface GraphStore {
  getFiles(): Promise<Map<string, FileRow>>;
  replaceFile(file: FileRow, extracted: ExtractResult): Promise<void>;
  touchFile(file: FileRow): Promise<void>;
  removeFiles(paths: string[]): Promise<void>;
  replaceEdges(edges: EdgeRow[]): Promise<void>;
  load(): Promise<GraphData>;
  close(): Promise<void>;
}

export function graphDbPath(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.EGC_DIR ? path.join(env.EGC_DIR, 'egc', 'graph') : path.join(env.HOME || env.USERPROFILE || os.homedir(), '.egc', 'graph');
  const slug = path.basename(projectRoot).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'project';
  const identity = process.platform === 'win32' ? projectRoot.toLowerCase() : projectRoot;
  const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
  return path.join(base, `${slug}-${hash}.db`);
}

const TABLES = ['files', 'symbols', 'imports', 'edges'];

async function initSchema(db: Database): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'version'");
  if (row && row.value !== String(GRAPH_SCHEMA_VERSION)) {
    for (const t of TABLES) await db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS symbols(id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      exported INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, refs TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file);
    CREATE TABLE IF NOT EXISTS imports(file TEXT NOT NULL, specifier TEXT NOT NULL, bindings TEXT NOT NULL, reexport INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS imports_file ON imports(file);
    CREATE TABLE IF NOT EXISTS edges(src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL);
  `);
  await db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('version', ?)", String(GRAPH_SCHEMA_VERSION));
}

async function inTransaction(db: Database, fn: () => Promise<void>): Promise<void> {
  await db.exec('BEGIN');
  try {
    await fn();
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

export async function openGraphStore(dbPath: string): Promise<GraphStore> {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = await openCompatDatabase(dbPath, 'egc-guardian');
  try {
    await initSchema(db);
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  }

  return {
    async getFiles() {
      const rows = await db.all<{ path: string; mtime_ms: number; size: number; hash: string }[]>('SELECT path, mtime_ms, size, hash FROM files');
      return new Map(rows.map(r => [r.path, { path: r.path, mtimeMs: r.mtime_ms, size: r.size, hash: r.hash }]));
    },
    async replaceFile(file, extracted) {
      await inTransaction(db, async () => {
        await db.run('DELETE FROM symbols WHERE file = ?', file.path);
        await db.run('DELETE FROM imports WHERE file = ?', file.path);
        await db.run('INSERT OR REPLACE INTO files(path, mtime_ms, size, hash) VALUES (?, ?, ?, ?)', file.path, file.mtimeMs, file.size, file.hash);
        for (const s of extracted.symbols) {
          await db.run(
            'INSERT INTO symbols(file, name, kind, exported, start_line, end_line, refs) VALUES (?, ?, ?, ?, ?, ?, ?)',
            file.path, s.name, s.kind, s.exported ? 1 : 0, s.startLine, s.endLine, JSON.stringify(s.refs)
          );
        }
        for (const im of extracted.imports) {
          await db.run('INSERT INTO imports(file, specifier, bindings, reexport) VALUES (?, ?, ?, ?)', file.path, im.specifier, JSON.stringify(im.bindings), im.reexport ? 1 : 0);
        }
      });
    },
    async touchFile(file) {
      await db.run('UPDATE files SET mtime_ms = ?, size = ? WHERE path = ?', file.mtimeMs, file.size, file.path);
    },
    async removeFiles(paths) {
      await inTransaction(db, async () => {
        for (const p of paths) {
          await db.run('DELETE FROM symbols WHERE file = ?', p);
          await db.run('DELETE FROM imports WHERE file = ?', p);
          await db.run('DELETE FROM files WHERE path = ?', p);
        }
      });
    },
    async replaceEdges(edges) {
      await inTransaction(db, async () => {
        await db.run('DELETE FROM edges');
        for (const e of edges) await db.run('INSERT INTO edges(src, dst, kind) VALUES (?, ?, ?)', e.src, e.dst, e.kind);
      });
    },
    async load() {
      const files = (await db.all<{ path: string; mtime_ms: number; size: number; hash: string }[]>('SELECT path, mtime_ms, size, hash FROM files ORDER BY path'))
        .map(r => ({ path: r.path, mtimeMs: r.mtime_ms, size: r.size, hash: r.hash }));
      const symbols = (await db.all<{ id: number; file: string; name: string; kind: string; exported: number; start_line: number; end_line: number; refs: string }[]>(
        'SELECT id, file, name, kind, exported, start_line, end_line, refs FROM symbols ORDER BY file, start_line, id'))
        .map(r => ({ id: r.id, file: r.file, name: r.name, kind: r.kind, exported: r.exported === 1, startLine: r.start_line, endLine: r.end_line, refs: JSON.parse(r.refs) as string[] }));
      const imports = (await db.all<{ file: string; specifier: string; bindings: string; reexport: number }[]>('SELECT file, specifier, bindings, reexport FROM imports ORDER BY file, rowid'))
        .map(r => ({ file: r.file, specifier: r.specifier, bindings: JSON.parse(r.bindings) as ImportBinding[], reexport: r.reexport === 1 }));
      const edges = await db.all<EdgeRow[]>('SELECT src, dst, kind FROM edges');
      return { files, symbols, imports, edges };
    },
    async close() {
      await db.close();
    }
  };
}

export async function openGraphStoreWithRecovery(dbPath: string): Promise<GraphStore> {
  try {
    return await openGraphStore(dbPath);
  } catch {
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(dbPath + suffix, { force: true });
    return openGraphStore(dbPath);
  }
}
