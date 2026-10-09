import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGraph, readFileWithin, withBuildLock, type BuildResult } from './graph-build.js';
import { queryGraph } from './graph-query.js';
import { graphDbPath, openGraphStoreWithRecovery, type GraphData } from './graph-store.js';

export interface ContextDeps {
  env?: NodeJS.ProcessEnv;
  // The full check, for the project root and for every file a snippet is read from.
  isProtectedPath?: (absPath: string) => boolean;
  // The cheap check applied to every file while the graph is built; defaults to isProtectedPath.
  isIndexExcluded?: (absPath: string) => boolean;
  transformSnippet?: (text: string) => string | null;
  audit?: (action: string, details: Record<string, unknown>) => void;
  // How long to wait for another process's build; defaults to LOCK_WAIT_MS.
  lockWaitMs?: number;
}

const unavailable = (reason: string): Record<string, unknown> => ({ status: 'unavailable', reason });

export function resolveRoot(projectPath: string | undefined): { root: string } | { reason: string } {
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(projectPath ?? process.cwd()));
    if (!fs.statSync(root).isDirectory()) return { reason: 'project path is not a directory' };
  } catch {
    return { reason: 'project path does not exist' };
  }
  if (path.parse(root).root === root) return { reason: 'refusing to index a filesystem root' };
  const home = (() => {
    try {
      return fs.realpathSync(os.homedir());
    } catch {
      return null;
    }
  })();
  if (home && root === home) return { reason: 'refusing to index the home directory; pass project_path' };
  return { root };
}

const MAX_SNIPPET_FILE_BYTES = 1024 * 1024;
// How long a caller waits for another process's build before the graph is reported unavailable.
const LOCK_WAIT_MS = 5000;

// The store is opened, built, read and closed while this process holds the
// build lock. The portable SQL engine keeps the whole database in memory and
// writes it back whole on close, so a handle opened before the lock could be
// a stale copy that overwrites what another process saved in the meantime.
async function buildAndLoad(
  root: string,
  dbPath: string,
  deps: ContextDeps
): Promise<{ build: BuildResult; data: GraphData } | null> {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const locked = await withBuildLock(
    dbPath,
    async () => {
      const store = await openGraphStoreWithRecovery(dbPath);
      try {
        const build = await buildGraph(root, store, { isProtectedPath: deps.isIndexExcluded ?? deps.isProtectedPath });
        return { build, data: await store.load() };
      } finally {
        await store.close().catch(() => undefined);
      }
    },
    { waitMs: deps.lockWaitMs ?? LOCK_WAIT_MS }
  );
  return locked.ran ? locked.value : null;
}

export async function buildRelevantContext(
  prompt: string,
  projectPath: string | undefined,
  budgetTokens: number | undefined,
  deps: ContextDeps = {}
): Promise<Record<string, unknown>> {
  const resolved = resolveRoot(projectPath);
  if ('reason' in resolved) return unavailable(resolved.reason);
  const { root } = resolved;
  const audit = deps.audit ?? (() => undefined);
  if (deps.isProtectedPath?.(root)) return unavailable('project path is protected');
  try {
    const loaded = await buildAndLoad(root, graphDbPath(root, deps.env), deps);
    if (!loaded) {
      audit('GRAPH_BUSY', { waited_ms: deps.lockWaitMs ?? LOCK_WAIT_MS });
      return unavailable('the code graph is being built by another process; try again shortly');
    }
    const { build, data } = loaded;
    audit('GRAPH_BUILD', { status: build.status, files: build.files, refreshed: build.refreshed, removed: build.removed, build_ms: build.buildMs });

    const result = await queryGraph(prompt, data, {
      budgetTokens,
      // Only the few files a snippet is cut from reach the full check.
      readFile: rel => (deps.isProtectedPath?.(path.join(root, rel)) ? Promise.resolve(null) : readFileWithin(root, rel, MAX_SNIPPET_FILE_BYTES)),
      transformSnippet: deps.transformSnippet
    });
    const snippets = result.files.reduce((sum, f) => sum + f.snippets.length, 0);
    audit('GRAPH_QUERY', { files: result.files.length, snippets, tokens_estimated: result.tokensEstimated, dropped: result.dropped });

    return {
      status: build.status === 'partial' ? 'partial' : 'ok',
      files: result.files.map(f => ({
        path: f.path,
        score: f.score,
        why: f.why,
        snippets: f.snippets.map(s => ({ symbol: s.symbol, start_line: s.startLine, end_line: s.endLine, text: s.text, ...(s.truncated ? { truncated: true } : {}) }))
      })),
      tokens_estimated: result.tokensEstimated,
      truncated: result.truncated,
      dropped: result.dropped,
      graph: { files: data.files.length, refreshed: build.refreshed, build_ms: build.buildMs, build: 'ran' }
    };
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    audit('GRAPH_ERROR', { reason });
    return unavailable(reason);
  }
}
