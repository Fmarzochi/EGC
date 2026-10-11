import type { GraphData, SymbolRow } from './graph-store.js';

export interface Snippet { symbol: string; startLine: number; endLine: number; text: string; truncated?: boolean }
export interface ContextFile { path: string; score: number; why: string[]; snippets: Snippet[] }
export interface RelevantContext { files: ContextFile[]; tokensEstimated: number; truncated: boolean; dropped: number }
export interface QueryOptions {
  budgetTokens?: number;
  seeds?: number;
  hops?: number;
  readFile: (relPath: string) => Promise<string | null>;
  transformSnippet?: (text: string) => string | null;
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'will', 'can', 'how', 'what', 'when', 'where', 'why', 'you', 'your', 'our',
  'use', 'using', 'add', 'make', 'get', 'set', 'new', 'all', 'any', 'not', 'but', 'has', 'have', 'should', 'would', 'could', 'please', 'need', 'want', 'file', 'code'
]);

// The text can come from a project file, so no step may backtrack: the acronym
// boundary is a lookahead (ABCDef -> ABC Def), which costs the same on a long
// run of capitals as on a short one. `([A-Z]+)([A-Z][a-z])` re-scanned the run
// from every position and took seconds on a hundred thousand capitals.
export function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1 ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STOP.has(w));
}

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
const lastSegment = (name: string): string => name.slice(name.lastIndexOf('.') + 1);

interface Reach { score: number; why: string }
interface Ranked extends Reach { s: SymbolRow }
interface AdjacentEdge { to: string; kind: 'import' | 'ref'; forward: boolean }
interface FileEntry { score: number; why: Set<string>; snippets: Snippet[] }

const byRank = (a: { s: SymbolRow; score: number }, b: { s: SymbolRow; score: number }): number =>
  b.score - a.score || (a.s.file < b.s.file ? -1 : a.s.file > b.s.file ? 1 : 0) || a.s.startLine - b.s.startLine;

function indexTokens(graph: GraphData): {
  nameTokens: Map<number, Set<string>>;
  fileTokens: Map<string, Set<string>>;
  idf: (t: string) => number;
} {
  const nameTokens = new Map<number, Set<string>>();
  const fileTokens = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const s of graph.symbols) {
    const own = new Set(splitWords(s.name));
    if (!fileTokens.has(s.file)) fileTokens.set(s.file, new Set(splitWords(s.file)));
    nameTokens.set(s.id, own);
    for (const t of new Set([...own, ...(fileTokens.get(s.file) as Set<string>)])) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = graph.symbols.length;
  const idf = (t: string): number => Math.log(1 + n / (1 + (df.get(t) ?? 0)));
  return { nameTokens, fileTokens, idf };
}

// Symbols whose own name or file path shares words with the prompt, best first.
function findSeeds(
  graph: GraphData,
  promptWords: Set<string>,
  promptIdents: Set<string>,
  seedCount: number
): { topSeeds: Array<{ s: SymbolRow; score: number }>; matched: Map<number, string[]> } {
  const { nameTokens, fileTokens, idf } = indexTokens(graph);
  const matched = new Map<number, string[]>();
  const seeds: Array<{ s: SymbolRow; score: number }> = [];
  for (const s of graph.symbols) {
    const own = nameTokens.get(s.id) as Set<string>;
    const fileOnly = [...(fileTokens.get(s.file) as Set<string>)].filter(t => !own.has(t));
    const hitsOwn = [...own].filter(t => promptWords.has(t));
    const hitsFile = fileOnly.filter(t => promptWords.has(t));
    let score = hitsOwn.reduce((a, t) => a + idf(t), 0) + 0.5 * hitsFile.reduce((a, t) => a + idf(t), 0);
    if (score <= 0) continue;
    if (promptIdents.has(lastSegment(s.name).toLowerCase())) score *= 2;
    if (s.exported) score *= 1.2;
    matched.set(s.id, [...hitsOwn, ...hitsFile]);
    seeds.push({ s, score });
  }
  seeds.sort(byRank);
  return { topSeeds: seeds.slice(0, seedCount), matched };
}

function buildAdjacency(edges: GraphData['edges']): Map<string, AdjacentEdge[]> {
  const adjacency = new Map<string, AdjacentEdge[]>();
  const link = (from: string, to: string, kind: 'import' | 'ref', forward: boolean): void => {
    const list = adjacency.get(from);
    const entry = { to, kind, forward };
    if (list) list.push(entry);
    else adjacency.set(from, [entry]);
  };
  for (const e of edges) {
    link(e.src, e.dst, e.kind, true);
    link(e.dst, e.src, e.kind, false);
  }
  return adjacency;
}

function describeEdge(edge: AdjacentEdge, from: string): string {
  if (edge.kind === 'import') return edge.forward ? `imported by ${from}` : `imports ${from}`;
  return edge.forward ? `called by ${from}` : `calls ${from}`;
}

// Walks the graph outward from the seeds, halving the score at every hop.
function spreadFromSeeds(
  topSeeds: Array<{ s: SymbolRow; score: number }>,
  matched: Map<number, string[]>,
  adjacency: Map<string, AdjacentEdge[]>,
  hops: number,
  label: (id: string) => string
): Map<string, Reach> {
  const best = new Map<string, Reach>();
  let frontier: string[] = [];
  for (const { s, score } of topSeeds) {
    const id = `s:${s.id}`;
    best.set(id, { score, why: `matched "${(matched.get(s.id) as string[]).slice(0, 3).join('", "')}"` });
    frontier.push(id);
  }
  for (let hop = 0; hop < hops; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      const from = best.get(id) as Reach;
      for (const edge of adjacency.get(id) ?? []) {
        const score = from.score * 0.5;
        const known = best.get(edge.to);
        if (known && known.score >= score) continue;
        best.set(edge.to, { score, why: describeEdge(edge, label(id)) });
        next.push(edge.to);
      }
    }
    frontier = next;
  }
  return best;
}

// Turns reached nodes into symbols: a reached file stands for its first exported symbols.
function rankCandidates(best: Map<string, Reach>, graph: GraphData, byId: Map<number, SymbolRow>): Ranked[] {
  const candidates = new Map<number, Reach>();
  const consider = (symbolId: number, reach: Reach): void => {
    const known = candidates.get(symbolId);
    if (!known || known.score < reach.score) candidates.set(symbolId, reach);
  };
  for (const [id, reach] of best) {
    if (id.startsWith('s:')) {
      consider(Number(id.slice(2)), reach);
    } else {
      const file = id.slice(2);
      const exported = graph.symbols.filter(s => s.file === file && s.exported).slice(0, 3);
      for (const s of exported) consider(s.id, { score: reach.score * 0.5, why: reach.why });
    }
  }
  return [...candidates.entries()]
    .map(([symbolId, reach]) => ({ s: byId.get(symbolId) as SymbolRow, ...reach }))
    .filter(c => c.s)
    .sort(byRank);
}

// Shortens a snippet by a fifth at a time until it fits one snippet's share of the budget.
function fitSnippet(lines: string[], maxOne: number): { lines: string[]; cut: boolean } {
  let kept = lines;
  let cut = false;
  while (kept.length > 1 && estimateTokens(kept.join('\n')) > maxOne) {
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length * 0.8)));
    cut = true;
  }
  return { lines: kept, cut };
}

async function cutSnippets(
  ranked: Ranked[],
  budget: number,
  opts: QueryOptions
): Promise<{ perFile: Map<string, FileEntry>; used: number; truncated: boolean; dropped: number }> {
  const fileLines = new Map<string, string[] | null>();
  const taken = new Map<string, Array<[number, number]>>();
  const perFile = new Map<string, FileEntry>();
  let used = 0;
  let truncated = false;
  let dropped = 0;
  const maxOne = Math.floor(budget * 0.4);

  for (const c of ranked) {
    if (used >= budget) {
      truncated = true;
      break;
    }
    const ranges = taken.get(c.s.file) ?? [];
    if (ranges.some(([a, b]) => c.s.startLine <= b && c.s.endLine >= a)) continue;
    if (!fileLines.has(c.s.file)) {
      const text = await opts.readFile(c.s.file);
      fileLines.set(c.s.file, text === null ? null : text.split('\n'));
    }
    const all = fileLines.get(c.s.file);
    if (!all) continue;

    const fitted = fitSnippet(all.slice(c.s.startLine - 1, c.s.endLine), maxOne);
    let text = fitted.lines.join('\n');
    if (opts.transformSnippet) {
      const out = opts.transformSnippet(text);
      if (out === null) {
        dropped++;
        continue;
      }
      text = out;
    }
    const tokens = estimateTokens(text);
    if (used + tokens > budget) {
      truncated = true;
      continue;
    }
    used += tokens;
    // The lines the reader was given, not the whole symbol: a snippet that was cut short must not hide
    // a symbol that sits in the part that was cut away.
    ranges.push([c.s.startLine, c.s.startLine + fitted.lines.length - 1]);
    taken.set(c.s.file, ranges);
    const entry = perFile.get(c.s.file) ?? { score: c.score, why: new Set<string>(), snippets: [] };
    entry.score = Math.max(entry.score, c.score);
    entry.why.add(c.why);
    entry.snippets.push({ symbol: c.s.name, startLine: c.s.startLine, endLine: c.s.startLine + fitted.lines.length - 1, text, ...(fitted.cut ? { truncated: true } : {}) });
    perFile.set(c.s.file, entry);
    if (fitted.cut) truncated = true;
  }
  return { perFile, used, truncated, dropped };
}

export async function queryGraph(prompt: string, graph: GraphData, opts: QueryOptions): Promise<RelevantContext> {
  const budget = opts.budgetTokens ?? 2000;
  const seedCount = opts.seeds ?? 8;
  const hops = opts.hops ?? 2;
  const empty: RelevantContext = { files: [], tokensEstimated: 0, truncated: false, dropped: 0 };

  const promptWords = new Set(splitWords(prompt));
  if (promptWords.size === 0) return empty;
  const promptIdents = new Set((prompt.match(/[A-Za-z_$][\w$]*/g) ?? []).map(w => w.toLowerCase()));

  const { topSeeds, matched } = findSeeds(graph, promptWords, promptIdents, seedCount);
  if (topSeeds.length === 0) return empty;

  const byId = new Map<number, SymbolRow>(graph.symbols.map(s => [s.id, s]));
  const label = (id: string): string => (id.startsWith('s:') ? byId.get(Number(id.slice(2)))?.name ?? id : id.slice(2));
  const best = spreadFromSeeds(topSeeds, matched, buildAdjacency(graph.edges), hops, label);
  const ranked = rankCandidates(best, graph, byId);
  const { perFile, used, truncated, dropped } = await cutSnippets(ranked, budget, opts);

  const files: ContextFile[] = [...perFile.entries()]
    .map(([p, e]) => ({ path: p, score: Math.round(e.score * 100) / 100, why: [...e.why].slice(0, 3), snippets: e.snippets.sort((a, b) => a.startLine - b.startLine) }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, tokensEstimated: used, truncated, dropped };
}
