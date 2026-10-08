/*
 * Copyright 2024 The Link Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * TypeScript port of thelink/scoring.py at commit 4f607a4 (github.com/UnforGBeast/thelink).
 */

const TOKEN_RE = /[a-zA-Z0-9]+/g;
const CAMEL_RE = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g;

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are',
  'be', 'this', 'that', 'it', 'with', 'as', 'at', 'by', 'from',
  'py', 'js', 'ts', 'tsx', 'jsx', 'go', 'rs', 'java', 'rb', 'md', 'txt',
  'src', 'lib', 'test', 'tests', 'spec'
]);

const MIN_STEM_LEN = 4;
const STEM_TAIL = 3;

export function stem(tok: string): string {
  if (tok.length < MIN_STEM_LEN) return tok;
  let t = tok;
  if (t.endsWith('ies') && t.length > 4) t = t.slice(0, -3) + 'y';
  else if (/(sses|shes|ches|xes|zes|ses)$/.test(t)) t = t.slice(0, -2);
  else if (t.endsWith('s') && !/(ss|us|is|as)$/.test(t)) t = t.slice(0, -1);
  if (t.endsWith('ing') && t.length - 3 >= STEM_TAIL) t = t.slice(0, -3);
  else if (t.endsWith('ed') && t.length - 2 >= STEM_TAIL) t = t.slice(0, -2);
  return t;
}

export function tokenize(text: string | undefined, opts: { stem?: boolean } = {}): string[] {
  const useStem = opts.stem ?? true;
  const out: string[] = [];
  for (const chunk of (text ?? '').match(TOKEN_RE) ?? []) {
    const parts = chunk.match(CAMEL_RE) ?? [chunk];
    for (const raw of parts) {
      const p = raw.toLowerCase();
      if (p.length < 2 || STOP.has(p)) continue;
      out.push(useStem ? stem(p) : p);
    }
  }
  return out;
}

export interface FileDoc {
  path: string;
  fields: { path: string[]; symbols: string[]; keywords: string[]; summary: string[] };
}

export const FIELD_WEIGHTS: Record<string, number> = { path: 3.0, symbols: 2.5, keywords: 1.5, summary: 1.0 };
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;
export const HISTORY_TERM_WEIGHT = 0.4;

function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

export class Bm25Index {
  private constructor(
    private readonly docTf: Array<Map<string, number>>,
    private readonly docLen: number[],
    private readonly avgdl: number,
    private readonly idf: Map<string, number>,
    private readonly vocab: string[]
  ) {}

  static build(docs: FileDoc[]): Bm25Index {
    const docTf: Array<Map<string, number>> = [];
    const docLen: number[] = [];
    const df = new Map<string, number>();
    for (const d of docs) {
      const tf = new Map<string, number>();
      for (const [field, toks] of Object.entries(d.fields)) {
        const fw = FIELD_WEIGHTS[field] ?? 1.0;
        for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + fw);
      }
      docTf.push(tf);
      docLen.push([...tf.values()].reduce((a, b) => a + b, 0));
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = docs.length;
    const avgdl = n ? docLen.reduce((a, b) => a + b, 0) / n : 0;
    const idf = new Map<string, number>();
    for (const [t, c] of df) idf.set(t, Math.log(1 + (n - c + 0.5) / (c + 0.5)));
    return new Bm25Index(docTf, docLen, avgdl, idf, [...df.keys()].sort());
  }

  expand(terms: string[]): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    for (const t of terms) {
      if (this.idf.has(t)) {
        out.push([t, 1.0]);
        continue;
      }
      if (t.length < 4) continue;
      for (const v of this.vocab) {
        if (v.length > t.length && v.startsWith(t)) {
          out.push([v, 0.5]);
          continue;
        }
        const cpl = commonPrefixLen(t, v);
        if (cpl >= 5 && t.length - cpl <= 3 && v.length - cpl <= 3) out.push([v, 0.5]);
      }
    }
    return out;
  }

  score(docIndex: number, weighted: Array<[string, number]>): number {
    const tf = this.docTf[docIndex];
    const dl = this.docLen[docIndex];
    if (!tf || tf.size === 0) return 0;
    const denom = BM25_K1 * (1 - BM25_B + BM25_B * (this.avgdl ? dl / this.avgdl : 0));
    let total = 0;
    for (const [term, qw] of weighted) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      total += qw * (this.idf.get(term) ?? 0) * (f * (BM25_K1 + 1)) / (f + denom);
    }
    return total;
  }
}

export interface GitContextLike {
  changed: Set<string>;
  branch: Set<string>;
  recent: Map<string, number>;
  cochange: Map<string, Map<string, number>>;
}

export interface ImportEdge { from: string; to: string; rel: 'imports' }

export interface ScoreContext {
  query: string;
  history: string;
  edges: ImportEdge[];
  extras: { gitSignal?: GitContextLike; graphHops?: number };
  queryTerms: string[];
  historyTerms: string[];
  bm25: Bm25Index | null;
  docIndex: Map<string, number>;
}

export interface SignalScore { name: string; raw: number; weight: number }
export interface ScoredDoc { doc: FileDoc; signals: SignalScore[]; total: number }

type SignalFn = (doc: FileDoc, ctx: ScoreContext) => number;
type PropagatorFn = (ranked: ScoredDoc[], ctx: ScoreContext, weight: number) => void;

const SIGNALS = new Map<string, { fn: SignalFn; weight: number }>();
const PROPAGATORS = new Map<string, { fn: PropagatorFn; weight: number }>();

export function signal(name: string, weight: number, fn: SignalFn): void {
  SIGNALS.set(name, { fn, weight });
}

export function propagator(name: string, weight: number, fn: PropagatorFn): void {
  PROPAGATORS.set(name, { fn, weight });
}

export function registeredSignals(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [n, s] of SIGNALS) out[n] = s.weight;
  for (const [n, p] of PROPAGATORS) out[n] = p.weight;
  return out;
}

export const DEFAULT_SIGNALS = ['bm25', 'path_hit'] as const;
export const DEFAULT_PROPAGATORS = ['import_graph'] as const;
const GRAPH_SEED_COUNT = 5;
const GRAPH_HOP_DECAY = 0.5;
const GRAPH_DEFAULT_HOPS = 2;

signal('bm25', 1.0, (doc, ctx) => {
  if (!ctx.bm25) return 0;
  const idx = ctx.bm25;
  const di = ctx.docIndex.get(doc.path);
  if (di === undefined) return 0;
  const weighted: Array<[string, number]> = [
    ...idx.expand(ctx.queryTerms),
    ...idx.expand(ctx.historyTerms).map(([t, w]): [string, number] => [t, w * HISTORY_TERM_WEIGHT])
  ];
  return idx.score(di, weighted);
});

signal('path_hit', 1.5, (doc, ctx) => {
  const pathTerms = new Set(doc.fields.path);
  const stemTerms = new Set(tokenize(doc.path.split('/').pop()?.replace(/\.[^.]*$/, '') ?? ''));
  const q = new Set(ctx.queryTerms);
  let hits = 0;
  for (const t of q) {
    if (pathTerms.has(t)) hits++;
    if (stemTerms.has(t)) hits++;
  }
  return hits;
});

// Import edges hold project-relative paths, so a target resolves by its exact
// path (with or without extension) and never by file name alone, which would
// credit a different file that happens to share the name.
function resolveImportTarget(target: string, byKey: Map<string, string>): string | undefined {
  if (byKey.has(target)) return byKey.get(target);
  const dotted = target.replace(/\./g, '/').replace(/^\/+|\/+$/g, '');
  for (const cand of [dotted, `${dotted}/__init__`, target.replace(/\\/g, '/').replace(/^\.\//, '')]) {
    if (byKey.has(cand)) return byKey.get(cand);
  }
  return undefined;
}

function buildKeyIndex(paths: Iterable<string>): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const p of paths) {
    const norm = p.replace(/\\/g, '/');
    if (!byKey.has(norm)) byKey.set(norm, p);
    const noExt = norm.replace(/\.[^./]+$/, '');
    if (!byKey.has(noExt)) byKey.set(noExt, p);
  }
  return byKey;
}

function buildImportAdjacency(paths: string[], edges: ImportEdge[], byKey: Map<string, string>): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const p of paths) adj.set(p, new Set());
  for (const e of edges) {
    if (e.rel !== 'imports') continue;
    const src = byKey.get(e.from.replace(/\\/g, '/')) ?? byKey.get(e.from.replace(/\\/g, '/').replace(/\.[^./]+$/, ''));
    const dst = resolveImportTarget(e.to, byKey);
    if (src && dst && src !== dst) {
      adj.get(src)?.add(dst);
      adj.get(dst)?.add(src);
    }
  }
  return adj;
}

function hopDistances(seeds: string[], adj: Map<string, Set<string>>, hops: number): Map<string, number> {
  const dist = new Map<string, number>(seeds.map(s => [s, 0]));
  let frontier = [...seeds];
  for (let d = 1; d <= hops && frontier.length; d++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const q of adj.get(p) ?? []) {
        if (!dist.has(q)) {
          dist.set(q, d);
          next.push(q);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

propagator('import_graph', 1.2, (ranked, ctx, weight) => {
  const hops = ctx.extras.graphHops ?? GRAPH_DEFAULT_HOPS;
  const emit = (raw: (sd: ScoredDoc) => number) => {
    for (const sd of ranked) sd.signals.push({ name: 'import_graph', raw: raw(sd), weight });
  };
  if (hops <= 0 || ctx.edges.length === 0) return emit(() => 0);

  const seeds = ranked.slice(0, GRAPH_SEED_COUNT).filter(sd => sd.total > 0).map(sd => sd.doc.path);
  if (seeds.length === 0) return emit(() => 0);

  const paths = ranked.map(sd => sd.doc.path);
  const adj = buildImportAdjacency(paths, ctx.edges, buildKeyIndex(paths));
  const dist = hopDistances(seeds, adj, hops);
  emit(sd => {
    const d = dist.get(sd.doc.path);
    return d && d >= 1 ? GRAPH_HOP_DECAY ** (d - 1) : 0;
  });
});

const byRank = (a: ScoredDoc, b: ScoredDoc): number =>
  b.total - a.total || (a.doc.path < b.doc.path ? -1 : a.doc.path > b.doc.path ? 1 : 0);

export function scoreDocuments(
  docs: FileDoc[],
  ctx: Omit<ScoreContext, 'queryTerms' | 'historyTerms' | 'bm25' | 'docIndex'>,
  opts: { signals?: readonly string[]; propagators?: readonly string[]; weights?: Record<string, number> } = {}
): ScoredDoc[] {
  const full: ScoreContext = {
    ...ctx,
    queryTerms: tokenize(ctx.query),
    historyTerms: tokenize(ctx.history),
    bm25: Bm25Index.build(docs),
    docIndex: new Map(docs.map((d, i) => [d.path, i]))
  };
  const activeSignals = opts.signals ?? DEFAULT_SIGNALS;
  const activeProps = opts.propagators ?? DEFAULT_PROPAGATORS;

  const ranked: ScoredDoc[] = docs.map(doc => {
    const signals: SignalScore[] = [];
    for (const name of activeSignals) {
      const s = SIGNALS.get(name);
      if (!s) continue;
      const w = opts.weights?.[name] ?? s.weight;
      if (w === 0) continue;
      signals.push({ name, raw: s.fn(doc, full), weight: w });
    }
    return { doc, signals, total: 0 };
  });
  const finish = () => {
    for (const sd of ranked) sd.total = sd.signals.reduce((a, s) => a + s.raw * s.weight, 0);
    ranked.sort(byRank);
  };
  finish();

  for (const name of activeProps) {
    const p = PROPAGATORS.get(name);
    if (!p) continue;
    const w = opts.weights?.[name] ?? p.weight;
    if (w === 0) continue;
    p.fn(ranked, full, w);
  }
  finish();
  return ranked;
}
