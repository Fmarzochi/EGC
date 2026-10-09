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
  // `**/` is any number of directories, none included; a bare `**` is anything.
  const body = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replaceAll('\u0001', '(?:.*/)?')
    .replaceAll('\u0002', '.*');
  const re = new RegExp(`${rooted ? '^' : '(?:^|/)'}${body}${dirOnly ? '/' : '(?:/|$)'}`);
  return (rel, isDir) => re.test(dirOnly && isDir ? rel + '/' : rel);
}

// Rules apply in order and the last one that matches decides, so `*.js` followed
// by `!keep.js` ignores every script but keep.js, as git does. (Git cannot
// re-include a file whose directory is ignored; the walk never enters one.)
export function makeIgnore(gitignoreText: string): IgnoreFn {
  const rules = gitignoreText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => ({ negate: l.startsWith('!'), pattern: l.startsWith('!') ? l.slice(1) : l }))
    .filter(r => r.pattern !== '')
    .map(r => ({ negate: r.negate, match: compileRule(r.pattern) }));
  return (rel, isDir) => {
    let ignored = false;
    for (const rule of rules) if (rule.match(rel, isDir)) ignored = !rule.negate;
    return ignored;
  };
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

function groupByFile<T extends { file: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.file);
    if (list) list.push(row);
    else out.set(row.file, [row]);
  }
  return out;
}

type BindingTarget = { target: string; imported: string };

export function computeEdges(data: Pick<GraphData, 'files' | 'symbols' | 'imports'>): EdgeRow[] {
  const fileSet = new Set(data.files.map(f => f.path));
  const byFile = groupByFile(data.symbols);
  const importsByFile = groupByFile(data.imports);
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
      // An empty specifier is an alias of a symbol in this very file (export { a as b }).
      const target = im.specifier === '' ? file : resolveSpecifier(file, im.specifier, fileSet);
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

  const refTarget = (
    s: SymbolRow,
    ref: string,
    sameFile: Map<string, SymbolRow>,
    bindingTarget: Map<string, BindingTarget>
  ): string | null => {
    if (ref.startsWith('.')) {
      const cls = s.name.includes('.') ? s.name.split('.')[0] : null;
      const hit = cls ? sameFile.get(`${cls}.${ref.slice(1)}`) : undefined;
      return hit ? `s:${hit.id}` : null;
    }
    const dot = ref.indexOf('.');
    if (dot > 0) {
      const bt = bindingTarget.get(ref.slice(0, dot));
      return bt && bt.imported === '*' ? findExport(bt.target, ref.slice(dot + 1), 0) : null;
    }
    const bt = bindingTarget.get(ref);
    if (bt) return bt.imported === '*' ? `f:${bt.target}` : (findExport(bt.target, bt.imported, 0) ?? `f:${bt.target}`);
    const local = sameFile.get(ref);
    return local ? `s:${local.id}` : null;
  };

  for (const file of data.files) {
    const bindingTarget = new Map<string, BindingTarget>();
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
      for (const ref of s.refs) {
        const hit = refTarget(s, ref, sameFile, bindingTarget);
        if (hit) add(`s:${s.id}`, hit, 'ref');
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

// Reads a regular file that lies inside root, or null. Null for: a path that
// leaves the root, a symbolic link as the file or as any directory on the way
// (also a Windows junction), a file that is swapped for another between the
// checks and the open, and a file larger than maxBytes, including one that
// grows while it is read. The graph reads project files at index time and again
// when it returns a snippet, and both must stay inside the project.
export async function readFileWithin(root: string, rel: string, maxBytes: number): Promise<string | null> {
  const abs = path.resolve(root, rel);
  const inside = path.relative(root, abs);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  let handle: fs.promises.FileHandle | undefined;
  try {
    const before = await fs.promises.lstat(abs);
    if (!before.isFile()) return null;
    if (path.relative(root, await fs.promises.realpath(abs)) !== inside) return null;
    handle = await fs.promises.open(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    if (st.ino !== 0 && before.ino !== 0 && (st.ino !== before.ino || st.dev !== before.dev)) return null;
    const buffer = Buffer.alloc(st.size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled); // NOSONAR: reads must follow each other, each starts where the last ended
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled > st.size ? null : buffer.toString('utf8', 0, filled);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

type IndexOutcome = 'skipped' | 'kept' | 'refreshed';

// One file of the walk: skipped (protected, unreadable, too large), kept as it
// was, or re-extracted into the store.
async function indexFile(
  root: string,
  rel: string,
  prev: { mtimeMs: number; ctimeMs: number; size: number; hash: string } | undefined,
  store: GraphStore,
  opts: BuildOptions,
  maxFileBytes: number,
  markEdgesDirty: () => Promise<void>
): Promise<IndexOutcome> {
  const abs = path.join(root, rel);
  if (opts.isProtectedPath?.(abs)) return 'skipped';
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(abs);
  } catch {
    return 'skipped';
  }
  if (!st.isFile() || st.size > maxFileBytes) return 'skipped';
  // Same size and modification time are not enough: a replacement can keep both. The change time cannot be set back.
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && prev.ctimeMs === st.ctimeMs) return 'kept';

  const text = await readFileWithin(root, rel, maxFileBytes);
  if (text === null) return 'skipped';
  const row = { path: rel, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, hash: crypto.createHash('sha256').update(text).digest('hex') };
  if (prev && prev.hash === row.hash) {
    await store.touchFile(row);
    return 'kept';
  }
  await markEdgesDirty();
  await store.replaceFile(row, extractFile(text));
  return 'refreshed';
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
  // File rows commit one by one and the edges last. The flag is set before the
  // first write and cleared by the same commit that replaces the edges, so a
  // build that dies in between leaves it set and the next build re-links.
  let edgesDirty = await store.edgesDirty();
  const markEdgesDirty = async (): Promise<void> => {
    if (edgesDirty) return;
    await store.markEdgesDirty();
    edgesDirty = true;
  };

  for (let k = 0; k < walked.files.length; k++) {
    const rel = walked.files[k];
    if (Date.now() > deadline) {
      truncated = true;
      for (const rest of walked.files.slice(k)) if (known.has(rest)) wanted.add(rest);
      break;
    }
    const outcome = await indexFile(root, rel, known.get(rel), store, opts, maxFileBytes, markEdgesDirty);
    if (outcome !== 'skipped') wanted.add(rel);
    if (outcome === 'refreshed') refreshed++;
  }

  const walkedSet = new Set(walked.files);
  const removable = [...known.keys()].filter(p => !wanted.has(p) && (!walked.truncated || walkedSet.has(p)));
  if (removable.length > 0) {
    await markEdgesDirty();
    await store.removeFiles(removable);
  }

  if (edgesDirty) {
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
  } catch (err) {
    // Only a lock that already exists means another process holds it; any
    // other failure (no directory, no permission) must not pass for "busy".
    // Windows also refuses a create while a delete of the old lock is pending.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY'))) return null;
    throw err;
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
  let movedToken: string | null;
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

const LOCK_POLL_MS = 50;

// Runs fn while holding the lock beside the database. With waitMs the caller
// waits for its turn that long before giving up with { ran: false }.
export async function withBuildLock<T>(
  dbPath: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number } = {}
): Promise<{ ran: true; value: T } | { ran: false }> {
  const lock = `${dbPath}.lock`;
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const giveUpAt = Date.now() + (opts.waitMs ?? 0);
  let fd = acquireLock(lock, token);
  if (fd === null && breakStaleLock(lock)) fd = acquireLock(lock, token);
  while (fd === null && Date.now() < giveUpAt) {
    await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS)); // NOSONAR: polling for the lock, one attempt per interval
    fd = acquireLock(lock, token);
    if (fd === null && breakStaleLock(lock)) fd = acquireLock(lock, token);
  }
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
