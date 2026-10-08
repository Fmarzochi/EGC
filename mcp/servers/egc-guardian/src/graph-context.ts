import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGraph, withBuildLock } from './graph-build.js';
import { queryGraph } from './graph-query.js';
import { graphDbPath, openGraphStoreWithRecovery } from './graph-store.js';

export interface ContextDeps {
  env?: NodeJS.ProcessEnv;
  isProtectedPath?: (absPath: string) => boolean;
  transformSnippet?: (text: string) => string | null;
  audit?: (action: string, details: Record<string, unknown>) => void;
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

async function readProjectFile(root: string, rel: string): Promise<string | null> {
  const abs = path.join(root, rel);
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(abs, 'r');
    const st = await handle.stat();
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    return await handle.readFile({ encoding: 'utf8' });
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
  let store: Awaited<ReturnType<typeof openGraphStoreWithRecovery>> | undefined;
  try {
    const dbPath = graphDbPath(root, deps.env);
    store = await openGraphStoreWithRecovery(dbPath);
    const locked = await withBuildLock(dbPath, () => buildGraph(root, store as NonNullable<typeof store>, { isProtectedPath: deps.isProtectedPath }));
    const build = locked.ran ? locked.value : null;
    if (build) audit('GRAPH_BUILD', { status: build.status, files: build.files, refreshed: build.refreshed, removed: build.removed, build_ms: build.buildMs });

    const data = await store.load();
    const result = await queryGraph(prompt, data, {
      budgetTokens,
      readFile: rel => readProjectFile(root, rel),
      transformSnippet: deps.transformSnippet
    });
    const snippets = result.files.reduce((sum, f) => sum + f.snippets.length, 0);
    audit('GRAPH_QUERY', { files: result.files.length, snippets, tokens_estimated: result.tokensEstimated, dropped: result.dropped });

    return {
      status: build?.status === 'partial' ? 'partial' : 'ok',
      files: result.files.map(f => ({
        path: f.path,
        score: f.score,
        why: f.why,
        snippets: f.snippets.map(s => ({ symbol: s.symbol, start_line: s.startLine, end_line: s.endLine, text: s.text, ...(s.truncated ? { truncated: true } : {}) }))
      })),
      tokens_estimated: result.tokensEstimated,
      truncated: result.truncated,
      dropped: result.dropped,
      graph: { files: data.files.length, refreshed: build?.refreshed ?? 0, build_ms: build?.buildMs ?? 0, build: build ? 'ran' : 'busy' }
    };
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    audit('GRAPH_ERROR', { reason });
    return unavailable(reason);
  } finally {
    await store?.close().catch(() => undefined);
  }
}
