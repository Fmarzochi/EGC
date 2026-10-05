import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { extractFile } from './graph-extract.js';
import type { EdgeRow, GraphData, GraphStore, SymbolRow } from './graph-store.js';

export interface BuildOptions {
  maxFiles?: number;
  maxMs?: number;
  maxFileBytes?: number;
  isProtectedPath?: (absPath: string) => boolean;
}
export interface BuildResult { status: 'ok' | 'partial'; files: number; refreshed: number; removed: number; buildMs: number }

const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const TEXT_EXT = /\.(?:[cm]?[jt]sx?|md|json|ya?ml|sh|txt|toml)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache', '.svn', '.hg', '.idea', '.vscode']);
const TS_SWAP: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] };
const TRY_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

type IgnoreFn = (rel: string, isDir: boolean) => boolean;

function compileRule(raw: string): IgnoreFn {
  let pat = raw;
  const dirOnly = pat.endsWith('/');
  if (dirOnly) pat = pat.slice(0, -1);
  const rooted = pat.startsWith('/') || pat.includes('/');
  if (pat.startsWith('/')) pat = pat.slice(1);
  const body = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replaceAll('\0', '.*');
  const re = new RegExp(`${rooted ? '^' : '(?:^|/)'}${body}${dirOnly ? '/' : '(?:/|$)'}`);
  return (rel, isDir) => re.test(dirOnly && isDir ? rel + '/' : rel);
}

export function makeIgnore(gitignoreText: string): IgnoreFn {
  const rules = gitignoreText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('!'))
    .map(compileRule);
  return (rel, isDir) => rules.some(rule => rule(rel, isDir));
}

export function resolveSpecifier(fromFile: string, specifier: string, fileSet: Set<string>): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../') && specifier !== '.' && specifier !== '..') return null;
  let base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (base === '..' || base.startsWith('../')) return null;
  if (base === '.') base = '';
  const prefix = base ? base + '/' : '';
  const candidates: string[] = base ? [base] : [];
  const ext = path.posix.extname(base);
  if (base && TS_SWAP[ext]) for (const e of TS_SWAP[ext]) candidates.push(base.slice(0, -ext.length) + e);
  if (base) for (const e of TRY_EXT) candidates.push(base + e);
  for (const e of TRY_EXT) candidates.push(`${prefix}index${e}`);
  return candidates.find(c => fileSet.has(c)) ?? null;
}

export function computeEdges(data: Pick<GraphData, 'files' | 'symbols' | 'imports'>): EdgeRow[] {
  const fileSet = new Set(data.files.map(f => f.path));
  const byFile = new Map<string, SymbolRow[]>();
  for (const s of data.symbols) {
    const list = byFile.get(s.file);
    if (list) list.push(s);
    else byFile.set(s.file, [s]);
  }
  const importsByFile = new Map<string, GraphData['imports']>();
  for (const im of data.imports) {
    const list = importsByFile.get(im.file);
    if (list) list.push(im);
    else importsByFile.set(im.file, [im]);
  }
  const edges = new Map<string, EdgeRow>();
  const add = (src: string, dst: string, kind: EdgeRow['kind']): void => {
    if (src !== dst) edges.set(`${kind}|${src}|${dst}`, { src, dst, kind });
  };

  const findExport = (file: string, name: string, depth: number): string | null => {
    const sym = (byFile.get(file) ?? []).find(s => s.exported && s.name === name);
    if (sym) return `s:${sym.id}`;
    if (depth >= 3) return null;
    for (const im of importsByFile.get(file) ?? []) {
      if (!im.reexport) continue;
      const target = resolveSpecifier(file, im.specifier, fileSet);
      if (!target) continue;
      for (const b of im.bindings) {
        let hit: string | null = null;
        if (b.local === name && b.imported !== '*') hit = findExport(target, b.imported, depth + 1);
        else if (b.local === '*' && b.imported === '*') hit = findExport(target, name, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };

  for (const file of data.files) {
    const bindingTarget = new Map<string, { target: string; imported: string }>();
    for (const im of importsByFile.get(file.path) ?? []) {
      const target = resolveSpecifier(file.path, im.specifier, fileSet);
      if (!target) continue;
      add(`f:${file.path}`, `f:${target}`, 'import');
      if (im.reexport) continue;
      for (const b of im.bindings) bindingTarget.set(b.local, { target, imported: b.imported });
    }
    const syms = byFile.get(file.path) ?? [];
    const sameFile = new Map<string, SymbolRow>();
    for (const s of syms) if (!sameFile.has(s.name)) sameFile.set(s.name, s);

    for (const s of syms) {
      const from = `s:${s.id}`;
      for (const ref of s.refs) {
        if (ref.startsWith('.')) {
          const cls = s.name.includes('.') ? s.name.split('.')[0] : null;
          const hit = cls ? sameFile.get(`${cls}.${ref.slice(1)}`) : undefined;
          if (hit) add(from, `s:${hit.id}`, 'ref');
          continue;
        }
        const dot = ref.indexOf('.');
        if (dot > 0) {
          const bt = bindingTarget.get(ref.slice(0, dot));
          if (bt && bt.imported === '*') {
            const hit = findExport(bt.target, ref.slice(dot + 1), 0);
            if (hit) add(from, hit, 'ref');
          }
          continue;
        }
        const bt = bindingTarget.get(ref);
        if (bt) {
          if (bt.imported === '*') add(from, `f:${bt.target}`, 'ref');
          else add(from, findExport(bt.target, bt.imported, 0) ?? `f:${bt.target}`, 'ref');
          continue;
        }
        const local = sameFile.get(ref);
        if (local) add(from, `s:${local.id}`, 'ref');
      }
    }
  }
  return [...edges.values()];
}

export async function walkFiles(
  root: string,
  ignore: IgnoreFn,
  accept: (name: string) => boolean,
  maxFiles: number,
  deadline: number
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const stack = [''];
  while (stack.length > 0) {
    if (Date.now() > deadline) return { files, truncated: true };
    const rel = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !ignore(childRel, true)) stack.push(childRel);
      } else if (e.isFile() && accept(e.name) && !ignore(childRel, false)) {
        if (files.length >= maxFiles) return { files, truncated: true };
        files.push(childRel);
      }
    }
  }
  return { files, truncated: false };
}

async function readText(abs: string, maxBytes: number): Promise<string | null> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(abs, 'r');
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    return await handle.readFile({ encoding: 'utf8' });
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function buildGraph(projectRoot: string, store: GraphStore, opts: BuildOptions = {}): Promise<BuildResult> {
  const started = Date.now();
  const maxFiles = opts.maxFiles ?? 5000;
  const maxMs = opts.maxMs ?? 20000;
  const maxFileBytes = opts.maxFileBytes ?? 1024 * 1024;
  const deadline = started + maxMs;
  const root = fs.realpathSync(projectRoot);

  let ignore: IgnoreFn = () => false;
  try {
    ignore = makeIgnore(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'));
  } catch {
    // no .gitignore
  }

  const walked = await walkFiles(root, ignore, name => SOURCE_EXT.test(name), maxFiles, deadline);
  const known = await store.getFiles();
  const wanted = new Set<string>();
  let refreshed = 0;
  let truncated = walked.truncated;

  for (let k = 0; k < walked.files.length; k++) {
    const rel = walked.files[k];
    if (Date.now() > deadline) {
      truncated = true;
      for (const rest of walked.files.slice(k)) if (known.has(rest)) wanted.add(rest);
      break;
    }
    const abs = path.join(root, rel);
    if (opts.isProtectedPath?.(abs)) continue;
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > maxFileBytes) continue;

    const prev = known.get(rel);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      wanted.add(rel);
      continue;
    }
    const text = await readText(abs, maxFileBytes);
    if (text === null) continue;
    const row = { path: rel, mtimeMs: st.mtimeMs, size: st.size, hash: crypto.createHash('sha1').update(text).digest('hex') };
    wanted.add(rel);
    if (prev && prev.hash === row.hash) {
      await store.touchFile(row);
      continue;
    }
    await store.replaceFile(row, extractFile(text));
    refreshed++;
  }

  const walkedSet = new Set(walked.files);
  const removable = [...known.keys()].filter(p => !wanted.has(p) && (!walked.truncated || walkedSet.has(p)));
  if (removable.length > 0) await store.removeFiles(removable);

  if (refreshed > 0 || removable.length > 0) {
    const data = await store.load();
    await store.replaceEdges(computeEdges(data));
  }

  return {
    status: truncated ? 'partial' : 'ok',
    files: wanted.size,
    refreshed,
    removed: removable.length,
    buildMs: Date.now() - started
  };
}

const LOCK_STALE_MS = 120_000;

function acquireLock(lock: string, token: string): number | null {
  try {
    const fd = fs.openSync(lock, 'wx');
    fs.writeSync(fd, token);
    return fd;
  } catch {
    return null;
  }
}

// Moves the lock aside and checks what was moved: only a lock whose owner
// token is the stale one we read is removed. A fresh lock moved by mistake
// is put back, so a racing breaker cannot take a live lock.
function breakStaleLock(lock: string): boolean {
  let staleToken: string;
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs <= LOCK_STALE_MS) return false;
    staleToken = fs.readFileSync(lock, 'utf8');
  } catch {
    return false;
  }
  const moved = `${lock}.break-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.renameSync(lock, moved);
  } catch {
    return false;
  }
  let movedToken: string | null = null;
  try {
    movedToken = fs.readFileSync(moved, 'utf8');
  } catch {
    movedToken = null;
  }
  if (movedToken === staleToken) {
    fs.rmSync(moved, { force: true });
    return true;
  }
  try {
    fs.linkSync(moved, lock);
  } catch {
    // another process already holds the path
  }
  fs.rmSync(moved, { force: true });
  return false;
}

export async function withBuildLock<T>(dbPath: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const lock = `${dbPath}.lock`;
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let fd = acquireLock(lock, token);
  if (fd === null && breakStaleLock(lock)) fd = acquireLock(lock, token);
  if (fd === null) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try {
      if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock);
    } catch { /* already removed */ }
  }
}
