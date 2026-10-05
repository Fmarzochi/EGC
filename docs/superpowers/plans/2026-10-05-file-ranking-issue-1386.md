# File Ranking with Git and Import-Graph Signals (Issue #1386) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `rank_files` MCP tool and `egc context` command that rank a project's files for a task using four signals (BM25, path hits, local git state, import-graph propagation), with an explain table on stderr and a three-block briefing on stdout.

**Architecture:** A TypeScript port of The Link's `scoring.py` (signal registry, field-weighted BM25, path hits, import-graph propagator) and `gitsignals.py` (local git state), in `mcp/servers/egc-guardian/src/`. A `file-index.ts` walks the project and builds scoring documents and import edges, reusing the graph store's walker and import resolver from the code-graph work. The MCP tool and the CLI both call one orchestrator, `rankProjectFiles`.

**Tech Stack:** TypeScript (Node16 modules) in the guardian server; Node built-ins only (`node:child_process`, `node:fs`, `node:path`); plain `node:assert` test scripts run by `tests/run-all.js`. No new dependencies.

**Spec:** GitHub issue #1386 (<https://github.com/Fmarzochi/EGC/issues/1386>) and The Link source at <https://github.com/UnforGBeast/thelink>, commit `4f607a4217e2fe5e6a8c9a07187058b96acb6c3f`, Apache-2.0 (`thelink/scoring.py`, `thelink/gitsignals.py`, `thelink/cli.py`, `thelink/graph.py`). Prerequisite: the code-graph work on `feat/my-contribution` (`graph-build.ts` exports `makeIgnore`, `resolveSpecifier`; `graph-extract.ts` exports `extractFile`).

## Global Constraints

- Signal weights, exactly: `bm25` 1.0, `path_hit` 1.5, `git` 1.0, `import_graph` 1.2.
- BM25: `k1 = 1.5`, `b = 0.75`; field weights `path` 3.0, `symbols` 2.5, `keywords` 1.5, `summary` 1.0; history terms weighted 0.4.
- Import graph: seeds are the top 5 files with a positive total, up to 2 hops, decay `0.5^(hop-1)`, edges undirected.
- Git: every `git` call has a 5000 ms timeout; outside a repository the git signal contributes 0 and nothing else changes.
- No network access. No new npm dependencies. Node built-ins only.
- Deterministic: ties break on path; path separators normalized to `/`.
- Cross-platform (Linux, macOS, Windows): normalize `\` to `/` in every path used as a key; `windowsHide: true` on spawns.
- No changes to `validate_command`, the Token Crusher, or the state schema.
- The state files are encrypted and owned by the memory server. The CLI and the file ranker never read them: history is an argument the caller supplies.
- Attribution: every new source file carries the Apache-2.0 header with `Copyright 2024 The Link Authors`; NOTICE and CHANGELOG credit The Link.
- Tests: `tests/egc-guardian-filerank-*.test.js`, `node:assert`, print `[SKIP]` and exit 0 when `mcp/servers/egc-guardian/build` is missing.

## Review Focus

- A query with no usable words, or a project with no files: `ranked: []`, not an error (Task 3 and Task 7 tests).
- A project path that is not a git repository, or whose git binary is missing or times out: the git signal is 0 and the ranking still returns (Task 4 tests).
- A detached HEAD and a repository with no default branch: branch signal is 0, no throw (Task 4 test).
- Windows backslash paths in git output and in import specifiers: matched as the same file (Task 4 and Task 5 tests).
- A file over the size cap or with a binary body: included by path only, never read whole (Task 5 test).
- A symlink inside the project pointing outside it: not indexed (Task 5 test, guarded where symlinks are unavailable).
- `history` containing secret-looking text: the briefing passes it through the existing `redactPayload` before printing (Task 6 test).

## Ruling notes (decided up front, recorded in the ledger when executed)

- **R1 (three files, not two):** the issue lists `file-index.ts` and `file-ranker.ts`. Git signals go in `file-git.ts`, mirroring The Link's separate `gitsignals.py`, so each file has one responsibility.
- **R2 (index reuses the graph walker):** `file-index.ts` imports `makeIgnore`, `resolveSpecifier` and a newly exported `walkSources` from `graph-build.ts` rather than duplicating them. Cost if wrong: one extra exported function.
- **R3 (non-source files are indexed too):** the issue ranks any file. JS/TS files get symbols and imports from `extractFile`; other text files (`.md`, `.json`, `.yml`, `.sh`) get path tokens and a summary from their first non-empty line. The walker is widened to accept these extensions; the graph store still only receives JS/TS.
- **R4 (history is supplied, not read):** `rank_files` takes a `history` argument from the caller (the assistant passes what `get_state` returned); `egc context` takes `--history <file>` or reads stdin. Cost if wrong: the caller must pass the history, as the CLAUDE.md protocol already requires.
- **R5 (reference commit pinned):** the port follows The Link at the commit above. Cost if wrong: later upstream changes are not picked up.
- **R6 (zero-score files are dropped):** The Link returns the top N even when every score is zero. This port drops zero-total files before the cut, so an unmatched query returns no files instead of an arbitrary list. Cost if wrong: an unmatched query returns fewer than N files.

---

## File Structure

| File | Responsibility |
|---|---|
| `mcp/servers/egc-guardian/src/file-ranker.ts` (new) | Tokenizer, stemmer, BM25 index, signal and propagator registries, `scoreDocuments`, `rankProjectFiles` orchestrator, explain table, briefing. |
| `mcp/servers/egc-guardian/src/file-git.ts` (new) | Local git state (`changed`, `branch`, `recent`, `cochange`) and the `git` signal. |
| `mcp/servers/egc-guardian/src/file-index.ts` (new) | Walk the project, build `FileDoc`s and import edges. |
| `mcp/servers/egc-guardian/src/graph-build.ts` (modify) | Export `walkSources`. |
| `mcp/servers/egc-guardian/src/index.ts` (modify) | Register the `rank_files` tool and its handler. |
| `scripts/context.js` (new) | `egc context` CLI: briefing on stdout, explain table on stderr. |
| `scripts/egc.js` (modify) | Register the `context` command. |
| `NOTICE`, `CHANGELOG.md`, `docs/token-optimization.md` (modify) | Attribution and documentation. |
| `tests/egc-guardian-filerank-*.test.js` (new) | One test file per module plus integration. |

---

### Task 1: Tokenizer, stemmer and stop list

**Files:**
- Create: `mcp/servers/egc-guardian/src/file-ranker.ts`
- Test: `tests/egc-guardian-filerank-tokenize.test.js`

**Interfaces:**
- Produces:
  - `tokenize(text: string, opts?: { stem?: boolean }): string[]`
  - `stem(tok: string): string` (exported for tests)

- [ ] **Step 1: Write the failing test**

Create `tests/egc-guardian-filerank-tokenize.test.js`:

```js
'use strict';
/**
 * Tokenisation turns text into lowercase identifier tokens, splitting on
 * non-alphanumerics and camelCase, dropping a small stop list, and trimming
 * plural and verb suffixes.
 *
 * Run with: node tests/egc-guardian-filerank-tokenize.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'file-ranker.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { tokenize, stem } = require(buildPath);

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

run('splits camelCase, PascalCase, snake_case, and path separators', () => {
  assert.deepStrictEqual(tokenize('AuthMiddleware', { stem: false }), ['auth', 'middleware']);
  assert.deepStrictEqual(tokenize('src/billing/payments_v2.py', { stem: false }), ['billing', 'payments']);
  assert.deepStrictEqual(tokenize('HTTPServer', { stem: false }), ['http', 'server']);
});

run('drops one-character tokens and the stop list (including path words and extensions)', () => {
  assert.deepStrictEqual(tokenize('the a src lib test py md', { stem: false }), []);
});

run('stem trims plural and verb suffixes only above the minimum length', () => {
  assert.strictEqual(stem('charges'), 'charge');
  assert.strictEqual(stem('policies'), 'policy');
  assert.strictEqual(stem('boxes'), 'box');
  assert.strictEqual(stem('authenticating'), 'authenticat');
  assert.strictEqual(stem('authenticated'), 'authenticat');
  assert.strictEqual(stem('bus'), 'bus');
  assert.strictEqual(stem('ring'), 'ring');
  assert.strictEqual(stem('cat'), 'cat');
});

run('tokenize stems by default and keeps duplicates for term frequency', () => {
  assert.deepStrictEqual(tokenize('charges charge'), ['charge', 'charge']);
});

run('empty and nullish input gives no tokens', () => {
  assert.deepStrictEqual(tokenize(''), []);
  assert.deepStrictEqual(tokenize(undefined), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/egc-guardian-filerank-tokenize.test.js`
Expected: `[SKIP] build not found...`. Not green.

- [ ] **Step 3: Write the implementation**

Create `mcp/servers/egc-guardian/src/file-ranker.ts`:

```ts
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
```

- [ ] **Step 4: Build, run, iterate until green**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-guardian-filerank-tokenize.test.js
```

Expected: 5 `PASS`, `0 failed`. The port must match `_stem` in the Link source exactly; if a test disagrees, check the rule against `thelink/scoring.py` at the pinned commit rather than relaxing the test. Note that `billing` stems to `bill` and `payments` to `payment`, which the later tasks rely on.

- [ ] **Step 5: Commit**

```bash
git add mcp/servers/egc-guardian/src/file-ranker.ts tests/egc-guardian-filerank-tokenize.test.js
git commit -m "feat(guardian): port The Link tokenizer and stemmer for file ranking"
```

---

### Task 2: Field-weighted BM25 index

**Files:**
- Modify: `mcp/servers/egc-guardian/src/file-ranker.ts`
- Test: `tests/egc-guardian-filerank-bm25.test.js`

**Interfaces:**
- Consumes: `tokenize`, `stem` (Task 1).
- Produces:
  - `interface FileDoc { path: string; fields: { path: string[]; symbols: string[]; keywords: string[]; summary: string[] } }`
  - `class Bm25Index` with `static build(docs: FileDoc[]): Bm25Index`, `expand(terms: string[]): Array<[string, number]>`, `score(docIndex: number, weighted: Array<[string, number]>): number`
  - Constants `FIELD_WEIGHTS`, `BM25_K1 = 1.5`, `BM25_B = 0.75`, `HISTORY_TERM_WEIGHT = 0.4` (exported).

- [ ] **Step 1: Write the failing test**

Create `tests/egc-guardian-filerank-bm25.test.js`:

```js
'use strict';
/**
 * The BM25 index scores files by weighted term frequency, with field weights
 * (path over symbols over keywords over summary), inverse document frequency,
 * and query-term expansion to longer or stem-related vocabulary.
 *
 * Run with: node tests/egc-guardian-filerank-bm25.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'file-ranker.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { Bm25Index, FIELD_WEIGHTS, BM25_K1, BM25_B, HISTORY_TERM_WEIGHT } = require(buildPath);

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}
const doc = (p, fields = {}) => ({ path: p, fields: { path: [], symbols: [], keywords: [], summary: [], ...fields } });

run('constants match The Link', () => {
  assert.deepStrictEqual(FIELD_WEIGHTS, { path: 3.0, symbols: 2.5, keywords: 1.5, summary: 1.0 });
  assert.strictEqual(BM25_K1, 1.5);
  assert.strictEqual(BM25_B, 0.75);
  assert.strictEqual(HISTORY_TERM_WEIGHT, 0.4);
});

run('a hit in the path field outranks the same hit in the summary', () => {
  const docs = [doc('a.ts', { path: ['billing'] }), doc('b.ts', { summary: ['billing'] })];
  const idx = Bm25Index.build(docs);
  const q = idx.expand(['billing']);
  assert.ok(idx.score(0, q) > idx.score(1, q));
});

run('a term in every document carries no weight (idf is low)', () => {
  const docs = [doc('a.ts', { summary: ['common'] }), doc('b.ts', { summary: ['common'] }), doc('c.ts', { summary: ['common', 'rare'] })];
  const idx = Bm25Index.build(docs);
  assert.ok(idx.score(2, idx.expand(['rare'])) > idx.score(2, idx.expand(['common'])));
});

run('expand: exact hit weight 1.0; prefix and stem-family hits 0.5; unknown dropped', () => {
  const idx = Bm25Index.build([doc('a.ts', { summary: ['authentication'] })]);
  assert.deepStrictEqual(idx.expand(['authentication']), [['authentication', 1.0]]);
  assert.deepStrictEqual(idx.expand(['auth']), [['authentication', 0.5]]);
  assert.deepStrictEqual(idx.expand(['zzzz']), []);
});

run('a document with no matching terms scores zero; an empty corpus does not throw', () => {
  const idx = Bm25Index.build([doc('a.ts', { summary: ['alpha'] })]);
  assert.strictEqual(idx.score(0, idx.expand(['beta'])), 0);
  assert.strictEqual(Bm25Index.build([]).expand(['x']).length, 0);
});

run('the weighting is deterministic: same input, same scores', () => {
  const docs = [doc('a.ts', { path: ['billing'], summary: ['pay'] }), doc('b.ts', { summary: ['billing', 'pay'] })];
  const a = Bm25Index.build(docs);
  const b = Bm25Index.build(docs);
  assert.strictEqual(a.score(0, a.expand(['billing'])), b.score(0, b.expand(['billing'])));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/egc-guardian-filerank-bm25.test.js`
Expected: `[SKIP]` only if the build lacks `file-ranker.js`; after Task 1's build it fails with `Bm25Index is not a constructor` (or `undefined`). Not green.

- [ ] **Step 3: Write the implementation**

Append to `mcp/servers/egc-guardian/src/file-ranker.ts`:

```ts

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
```

Note: `expand` may push the same vocabulary term more than once (a prefix hit and a stem hit for the same term). That matches the Link's `expand`, which also appends per match; keep it.

- [ ] **Step 4: Build, run, iterate until green**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-guardian-filerank-bm25.test.js
```

Expected: 6 `PASS`, `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add mcp/servers/egc-guardian/src/file-ranker.ts tests/egc-guardian-filerank-bm25.test.js
git commit -m "feat(guardian): add the field-weighted BM25 index for file ranking"
```

---

### Task 3: Signal registry, path hits, import-graph propagator, and `scoreDocuments`

**Files:**
- Modify: `mcp/servers/egc-guardian/src/file-ranker.ts`
- Test: `tests/egc-guardian-filerank-score.test.js`

**Interfaces:**
- Consumes: `FileDoc`, `Bm25Index`, `tokenize` (Tasks 1–2).
- Produces:
  - `interface ImportEdge { from: string; to: string; rel: 'imports' }`
  - `interface ScoreContext { query: string; history: string; edges: ImportEdge[]; extras: { gitSignal?: GitContextLike; graphHops?: number }; queryTerms: string[]; historyTerms: string[]; bm25: Bm25Index | null; docIndex: Map<string, number> }`
  - `interface SignalScore { name: string; raw: number; weight: number }`
  - `interface ScoredDoc { doc: FileDoc; signals: SignalScore[]; total: number }`
  - `signal(name, weight, fn)`, `propagator(name, weight, fn)` registries; `DEFAULT_SIGNALS = ['bm25', 'path_hit']`; `DEFAULT_PROPAGATORS = ['import_graph']`
  - `scoreDocuments(docs: FileDoc[], ctx: ScoreContext, opts?: { signals?: string[]; propagators?: string[]; weights?: Record<string, number> }): ScoredDoc[]`
  - `GitContextLike` is the shape defined in Task 4: `{ changed: Set<string>; branch: Set<string>; recent: Map<string, number>; cochange: Map<string, Map<string, number>> }`.

- [ ] **Step 1: Write the failing test**

Create `tests/egc-guardian-filerank-score.test.js`:

```js
'use strict';
/**
 * scoreDocuments combines the registered per-file signals, then the
 * import-graph propagator, and returns documents best first with a per-signal
 * breakdown. Ties break on path.
 *
 * Run with: node tests/egc-guardian-filerank-score.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'file-ranker.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { scoreDocuments, tokenize, Bm25Index, registeredSignals } = require(buildPath);

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}
const docOf = (p, summary = '') => ({
  path: p,
  fields: { path: tokenize(p), symbols: [], keywords: [], summary: tokenize(summary) }
});
const ctx = (query, edges = [], extras = {}) => ({ query, history: '', edges, extras });

run('registered weights match the issue: bm25 1.0, path_hit 1.5, import_graph 1.2', () => {
  const w = registeredSignals();
  assert.strictEqual(w.bm25, 1.0);
  assert.strictEqual(w.path_hit, 1.5);
  assert.strictEqual(w.import_graph, 1.2);
});

run('a file whose path segment matches the query ranks first, with a path_hit breakdown', () => {
  const docs = [docOf('src/misc.ts', 'payments'), docOf('billing/payments.ts', 'something else')];
  const ranked = scoreDocuments(docs, ctx('fix payments'));
  assert.strictEqual(ranked[0].doc.path, 'billing/payments.ts');
  const names = ranked[0].signals.map(s => s.name);
  assert.ok(names.includes('path_hit') && names.includes('bm25'));
});

run('path_hit counts a query term once for each path token and once more for the file stem', () => {
  // query tokens: payment, bill. path tokens: bill, payment. stem: payment.
  const ranked = scoreDocuments([docOf('billing/payments.ts')], ctx('payments billing'));
  const ph = ranked[0].signals.find(s => s.name === 'path_hit');
  assert.strictEqual(ph.raw, 3);
  assert.strictEqual(ph.weight, 1.5);
});

run('import_graph: the seed gets 0, a one-hop neighbour 1.0, a two-hop file 0.5 (undirected)', () => {
  const docs = [docOf('a.ts', 'billing'), docOf('b.ts'), docOf('c.ts'), docOf('d.ts')];
  const edges = [{ from: 'a.ts', to: 'b.ts', rel: 'imports' }, { from: 'c.ts', to: 'b.ts', rel: 'imports' }];
  const ranked = scoreDocuments(docs, ctx('billing', edges), { signals: ['bm25'] });
  const ig = p => ranked.find(r => r.doc.path === p).signals.find(s => s.name === 'import_graph');
  assert.strictEqual(ig('a.ts').raw, 0, 'seed is not boosted by its own walk');
  assert.strictEqual(ig('b.ts').raw, 1.0, 'one hop from the seed: 0.5^0');
  assert.strictEqual(ig('c.ts').raw, 0.5, 'two hops from the seed: 0.5^1');
  assert.strictEqual(ig('d.ts').raw, 0, 'unconnected');
});

run('import_graph: hops 0 disables the walk; no edges gives zero contributions', () => {
  const docs = [docOf('a.ts', 'billing'), docOf('b.ts')];
  const edges = [{ from: 'a.ts', to: 'b.ts', rel: 'imports' }];
  const off = scoreDocuments(docs, ctx('billing', edges, { graphHops: 0 }));
  assert.ok(off.every(r => r.signals.find(s => s.name === 'import_graph').raw === 0));
  const none = scoreDocuments(docs, ctx('billing', []));
  assert.ok(none.every(r => r.signals.find(s => s.name === 'import_graph').raw === 0));
});

run('import_graph seeds only the top 5 files: a sixth file is reached as a neighbour, not a seed', () => {
  // m0..m6 all match equally, so they rank by path: m0..m4 are the five seeds.
  const docs = Array.from({ length: 7 }, (_, i) => docOf(`m${i}.ts`, 'billing'));
  const edges = [
    { from: 'm4.ts', to: 'm5.ts', rel: 'imports' },
    { from: 'm6.ts', to: 'm5.ts', rel: 'imports' }
  ];
  const ranked = scoreDocuments(docs, ctx('billing', edges));
  const ig = p => ranked.find(r => r.doc.path === p).signals.find(s => s.name === 'import_graph').raw;
  assert.strictEqual(ig('m5.ts'), 1.0, 'm5 is one hop from seed m4, so it is not itself a seed');
  assert.strictEqual(ig('m6.ts'), 0.5, 'm6 is two hops from seed m4');
});

run('a query with no usable words scores every file zero and returns all of them in path order', () => {
  const docs = [docOf('b.ts'), docOf('a.ts')];
  const ranked = scoreDocuments(docs, ctx('the and'));
  assert.deepStrictEqual(ranked.map(r => r.doc.path), ['a.ts', 'b.ts']);
  assert.ok(ranked.every(r => r.total === 0));
});

run('weights override: weight 0 removes a signal from the breakdown', () => {
  const ranked = scoreDocuments([docOf('billing.ts')], ctx('billing'), { weights: { path_hit: 0 } });
  assert.ok(!ranked[0].signals.some(s => s.name === 'path_hit'));
});

run('the same input always gives the same order', () => {
  const docs = [docOf('x.ts', 'billing'), docOf('y.ts', 'billing'), docOf('z.ts', 'billing')];
  const a = scoreDocuments(docs, ctx('billing')).map(r => r.doc.path);
  const b = scoreDocuments(docs, ctx('billing')).map(r => r.doc.path);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a, ['x.ts', 'y.ts', 'z.ts']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/egc-guardian-filerank-score.test.js`
Expected: fails with `scoreDocuments is not a function`. Not green.

- [ ] **Step 3: Write the implementation**

Append to `mcp/servers/egc-guardian/src/file-ranker.ts`:

```ts

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

function resolveImportTarget(target: string, byKey: Map<string, string>): string | undefined {
  if (byKey.has(target)) return byKey.get(target);
  const dotted = target.replace(/\./g, '/').replace(/^\/+|\/+$/g, '');
  for (const cand of [dotted, `${dotted}/__init__`, target.replace(/\\/g, '/').replace(/^\.\//, '')]) {
    if (byKey.has(cand)) return byKey.get(cand);
  }
  const stemName = target.replace(/^[./\\]+|[./\\]+$/g, '').split(/[./\\]/).pop() ?? '';
  return byKey.get(`stem:${stemName}`);
}

propagator('import_graph', 1.2, (ranked, ctx, weight) => {
  const hops = ctx.extras.graphHops ?? GRAPH_DEFAULT_HOPS;
  const byPath = new Map(ranked.map(sd => [sd.doc.path, sd]));
  const emit = (raw: (sd: ScoredDoc) => number) => {
    for (const sd of ranked) sd.signals.push({ name: 'import_graph', raw: raw(sd), weight });
  };
  if (hops <= 0 || ctx.edges.length === 0) return emit(() => 0);

  const byKey = new Map<string, string>();
  for (const p of byPath.keys()) {
    const norm = p.replace(/\\/g, '/');
    if (!byKey.has(norm)) byKey.set(norm, p);
    const noExt = norm.replace(/\.[^./]+$/, '');
    if (!byKey.has(noExt)) byKey.set(noExt, p);
    const stemName = (norm.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
    if (!byKey.has(`stem:${stemName}`)) byKey.set(`stem:${stemName}`, p);
  }

  const adj = new Map<string, Set<string>>();
  for (const p of byPath.keys()) adj.set(p, new Set());
  for (const e of ctx.edges) {
    if (e.rel !== 'imports') continue;
    const src = byKey.get(e.from.replace(/\\/g, '/')) ?? byKey.get(e.from.replace(/\\/g, '/').replace(/\.[^./]+$/, ''));
    const dst = resolveImportTarget(e.to, byKey);
    if (src && dst && src !== dst) {
      adj.get(src)?.add(dst);
      adj.get(dst)?.add(src);
    }
  }

  const seeds = ranked.slice(0, GRAPH_SEED_COUNT).filter(sd => sd.total > 0).map(sd => sd.doc.path);
  if (seeds.length === 0) return emit(() => 0);

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
```

Note on `HISTORY_TERM_WEIGHT` and `BM25` in the code above: the `bm25` signal uses `HISTORY_TERM_WEIGHT` declared in Task 2. The `path_hit` signal follows The Link: `len(q & path_terms) + len(q & stem)`, so a term that is both a path segment and the stem counts twice; the test in this task expects that.

- [ ] **Step 4: Build, run, iterate until green**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-guardian-filerank-score.test.js
```

Expected: 9 `PASS`, `0 failed`. The `git` weight is asserted in Task 4, once `file-git.ts` registers it. If a `path_hit` or `import_graph` number differs, recount with the rule in the test name before changing the expectation; the numbers above were worked out from the stemmer (`billing` to `bill`, `payments` to `payment`).

- [ ] **Step 5: Commit**

```bash
git add mcp/servers/egc-guardian/src/file-ranker.ts tests/egc-guardian-filerank-score.test.js
git commit -m "feat(guardian): add the signal registry, path hits, import-graph propagation and scoreDocuments"
```

---

### Task 4: Local git signal

**Files:**
- Create: `mcp/servers/egc-guardian/src/file-git.ts`
- Modify: `mcp/servers/egc-guardian/src/file-ranker.ts` (import `file-git.ts` so the `git` signal registers)
- Test: `tests/egc-guardian-filerank-git.test.js`

**Interfaces:**
- Consumes: `signal`, `FileDoc`, `ScoreContext`, `GitContextLike` (Task 3).
- Produces:
  - `collectGitContext(projectPath: string): GitContextLike | null`
  - `signal('git', 1.0, ...)` registered on import.
  - `matchPath(docPath: string, keys: Iterable<string>): string | undefined` (suffix-tolerant, exported for tests).

- [ ] **Step 1: Write the failing test**

Create `tests/egc-guardian-filerank-git.test.js`:

```js
'use strict';
/**
 * The git signal reads a local repository only: uncommitted changes, files
 * changed on the branch, recency and co-change of recent commits. Outside a
 * repository, or when git is unavailable, it contributes nothing.
 *
 * Run with: node tests/egc-guardian-filerank-git.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'file-git.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { collectGitContext, matchPath } = require(path.join(buildDir, 'file-git.js'));
const { scoreDocuments, tokenize } = require(path.join(buildDir, 'file-ranker.js'));

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const gitAvailable = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-filerank-git-'));

run('outside a repository: no context, signal is zero', () => {
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  assert.strictEqual(collectGitContext(plain), null);
});

run('a missing project path is not a repository', () => {
  assert.strictEqual(collectGitContext(path.join(tmp, 'nope')), null);
});

run('matchPath is suffix-tolerant and normalizes backslashes', () => {
  const keys = new Set(['src/billing/payments.ts', 'README.md']);
  assert.strictEqual(matchPath('billing/payments.ts', keys), 'src/billing/payments.ts');
  assert.strictEqual(matchPath('src\\billing\\payments.ts', keys), 'src/billing/payments.ts');
  assert.strictEqual(matchPath('other/unknown.ts', keys), undefined);
});

if (gitAvailable) {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'billing'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'billing', 'payments.ts'), 'export const pay = 1;\n');
  fs.writeFileSync(path.join(repo, 'billing', 'refunds.ts'), 'export const refund = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(repo, 'billing', 'payments.ts'), 'export const pay = 2;\n');
  git(repo, 'commit', '-qam', 'change payments');
  fs.writeFileSync(path.join(repo, 'billing', 'refunds.ts'), 'export const refund = 2;\n');

  run('a repository reports uncommitted changes, branch changes and recency', () => {
    const ctx = collectGitContext(repo);
    assert.ok(ctx, 'context present');
    assert.ok(ctx.changed.has('billing/refunds.ts'), 'uncommitted file');
    assert.ok(ctx.branch.has('billing/payments.ts'), 'file changed on the branch');
    assert.ok(ctx.recent.get('billing/payments.ts') > 0, 'recent commit file');
  });

  run('co-change counts files committed together (the init commit holds both)', () => {
    const ctx = collectGitContext(repo);
    assert.strictEqual(ctx.cochange.get('billing/payments.ts').get('billing/refunds.ts'), 1);
  });

  run('registers the git signal with weight 1.0', () => {
    assert.strictEqual(require(path.join(buildDir, 'file-ranker.js')).registeredSignals().git, 1.0);
  });

  run('the git signal adds to a file with uncommitted changes and scores zero without git context', () => {
    const ctx = collectGitContext(repo);
    const docs = [
      { path: 'billing/refunds.ts', fields: { path: tokenize('billing/refunds.ts'), symbols: [], keywords: [], summary: [] } },
      { path: 'billing/other.ts', fields: { path: tokenize('billing/other.ts'), symbols: [], keywords: [], summary: [] } }
    ];
    const withGit = scoreDocuments(docs, { query: 'billing', history: '', edges: [], extras: { gitSignal: ctx } }, { signals: ['bm25', 'git'], propagators: [] });
    assert.strictEqual(withGit[0].doc.path, 'billing/refunds.ts');
    const noGit = scoreDocuments(docs, { query: 'billing', history: '', edges: [], extras: {} }, { signals: ['git'], propagators: [] });
    assert.ok(noGit.every(r => r.total === 0));
  });

  run('an unborn or detached HEAD does not throw', () => {
    const detached = path.join(tmp, 'detached');
    fs.mkdirSync(detached);
    git(detached, 'init', '-q');
    assert.doesNotThrow(() => collectGitContext(detached));
  });
} else {
  console.log('  SKIP repository tests (git not on PATH)');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/egc-guardian-filerank-git.test.js`
Expected: `[SKIP]` before the build; after Task 3's build, `Cannot find module .../file-git.js`. Not green.

- [ ] **Step 3: Write the implementation**

Create `mcp/servers/egc-guardian/src/file-git.ts`:

```ts
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
 * TypeScript port of thelink/gitsignals.py at commit 4f607a4 (github.com/UnforGBeast/thelink).
 */
import { spawnSync } from 'node:child_process';
import { signal, type FileDoc, type GitContextLike, type ScoreContext } from './file-ranker.js';

const LOG_LIMIT = 50;
const MAX_FILES_PER_COMMIT = 100;
const DEFAULT_BRANCHES = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
const W_CHANGED = 1.0;
const W_BRANCH = 0.7;
const W_RECENT = 0.6;
const W_COCHANGE = 0.5;

function runGit(projectPath: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', projectPath, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

const norm = (p: string): string => p.replace(/\\/g, '/').trim().replace(/^\.\/+/, '');

function changedPaths(projectPath: string): Set<string> {
  const out = runGit(projectPath, ['status', '--porcelain', '-z']);
  const paths = new Set<string>();
  if (!out) return paths;
  for (const entry of out.split('\0')) {
    if (entry.length > 3) paths.add(norm(entry.slice(3)));
  }
  return paths;
}

function branchPaths(projectPath: string): Set<string> {
  let base: string | null = null;
  for (const ref of DEFAULT_BRANCHES) {
    const mb = runGit(projectPath, ['merge-base', 'HEAD', ref]);
    if (mb && mb.trim()) {
      base = mb.trim();
      break;
    }
  }
  if (!base) return new Set();
  const head = runGit(projectPath, ['rev-parse', 'HEAD']);
  if (head && head.trim() === base) return new Set();
  const diff = runGit(projectPath, ['diff', '--name-only', `${base}...HEAD`]);
  return new Set((diff ?? '').split('\n').filter(l => l.trim()).map(norm));
}

function recentAndCochange(projectPath: string): { recent: Map<string, number>; cochange: Map<string, Map<string, number>> } {
  const recent = new Map<string, number>();
  const cochange = new Map<string, Map<string, number>>();
  const raw = runGit(projectPath, ['log', `-${LOG_LIMIT}`, '--name-only', '--pretty=format:%x01%H', '--no-merges']);
  if (!raw) return { recent, cochange };

  const commits: string[][] = [];
  let current: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('\x01')) {
      if (current.length) commits.push(current);
      current = [];
    } else if (line.trim()) {
      current.push(norm(line));
    }
  }
  if (current.length) commits.push(current);

  const n = Math.max(commits.length, 1);
  commits.forEach((files, i) => {
    if (files.length > MAX_FILES_PER_COMMIT) return;
    const w = (n - i) / n;
    for (const f of files) {
      if (w > (recent.get(f) ?? 0)) recent.set(f, w);
    }
    for (const a of files) {
      let bucket = cochange.get(a);
      if (!bucket) {
        bucket = new Map();
        cochange.set(a, bucket);
      }
      for (const b of files) {
        if (a !== b) bucket.set(b, (bucket.get(b) ?? 0) + 1);
      }
    }
  });
  return { recent, cochange };
}

export function collectGitContext(projectPath: string): GitContextLike | null {
  if (runGit(projectPath, ['rev-parse', '--is-inside-work-tree']) === null) return null;
  const changed = changedPaths(projectPath);
  const branch = branchPaths(projectPath);
  const { recent, cochange } = recentAndCochange(projectPath);
  if (changed.size === 0 && branch.size === 0 && recent.size === 0) return null;
  return { changed, branch, recent, cochange };
}

export function matchPath(docPath: string, keys: Iterable<string>): string | undefined {
  const d = norm(docPath);
  const list = [...keys];
  if (list.includes(d)) return d;
  for (const k of list) {
    if (k.endsWith('/' + d) || d.endsWith('/' + k)) return k;
  }
  const base = d.split('/').pop();
  return list.find(k => k.split('/').pop() === base);
}

signal('git', 1.0, (doc: FileDoc, ctx: ScoreContext) => {
  const git = ctx.extras.gitSignal;
  if (!git) return 0;
  let score = 0;
  if (matchPath(doc.path, git.changed)) score += W_CHANGED;
  if (matchPath(doc.path, git.branch)) score += W_BRANCH;
  const rk = matchPath(doc.path, git.recent.keys());
  if (rk) score += W_RECENT * (git.recent.get(rk) ?? 0);
  const ck = matchPath(doc.path, git.cochange.keys());
  if (ck && git.changed.size > 0) {
    const bucket = git.cochange.get(ck) ?? new Map<string, number>();
    let hits = 0;
    for (const c of git.changed) hits += bucket.get(c) ?? 0;
    if (hits) score += W_COCHANGE * Math.min(hits / 3, 1);
  }
  return score;
});
```

Then in `file-ranker.ts`, the `git` signal must be registered before `scoreDocuments` runs. Add this line at the bottom of `file-ranker.ts`:

```ts
import './file-git.js';
```

Put it with the other imports at the top of the file, not the bottom. Circularity: `file-git.ts` imports `signal` from `file-ranker.ts`, and `file-ranker.ts` imports `file-git.ts` for its side effect. To avoid the cycle, instead register `git` from `file-git.ts` and have the orchestrator (Task 7, `file-index`/`rankProjectFiles`) import `file-git.ts`. Do that: do not add the import to `file-ranker.ts`. The `git` signal is registered when the orchestrator loads `file-git.ts`.

- [ ] **Step 4: Build, run, iterate until green**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-guardian-filerank-git.test.js
node tests/egc-guardian-filerank-score.test.js
```

Expected: 8 `PASS` for the git test, `0 failed`. Co-change is exactly 1 because the fixture's init commit holds `payments` and `refunds` together and nothing else pairs them. Then re-run `node tests/egc-guardian-filerank-score.test.js` and confirm it still passes.

- [ ] **Step 5: Commit**

```bash
git add mcp/servers/egc-guardian/src/file-git.ts tests/egc-guardian-filerank-git.test.js tests/egc-guardian-filerank-score.test.js
git commit -m "feat(guardian): add the local-git ranking signal with a 5 second timeout"
```

---

### Task 5: Project index (`file-index.ts`)

**Files:**
- Create: `mcp/servers/egc-guardian/src/file-index.ts`
- Modify: `mcp/servers/egc-guardian/src/graph-build.ts` (export `walkSources`; widen it to non-source text files)
- Test: `tests/egc-guardian-filerank-index.test.js`

**Interfaces:**
- Consumes: `makeIgnore`, `resolveSpecifier` (graph-build, Task-prerequisite); `extractFile` (graph-extract); `FileDoc`, `ImportEdge` (Task 3); `tokenize` (Task 1).
- Produces:
  - `buildFileIndex(projectRoot: string): Promise<{ docs: FileDoc[]; edges: ImportEdge[]; skipped: number }>`
  - Constants: `TEXT_EXT` (exported from `graph-build.ts`, matches `.ts .tsx .js .jsx .mjs .cjs .mts .cts .md .json .yml .yaml .sh .txt .toml`), `MAX_FILE_BYTES = 256 * 1024` (exported from `file-index.ts`).

- [ ] **Step 1: Write the failing test**

Create `tests/egc-guardian-filerank-index.test.js`:

```js
'use strict';
/**
 * The project index walks a project, skipping ignored and protected paths,
 * and builds ranking documents: path tokens everywhere, symbols and imports
 * for JS/TS, and a summary from the first non-empty line.
 *
 * Run with: node tests/egc-guardian-filerank-index.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'file-index.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { buildFileIndex, MAX_FILE_BYTES } = require(path.join(buildDir, 'file-index.js'));

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.stack || err.message}`);
    failed++;
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-filerank-index-'));
let n = 0;
function project(files) {
  const root = path.join(tmp, `p${n++}`);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

(async () => {
  await run('indexes text files, skips node_modules, dist and .gitignore matches', async () => {
    const root = project({
      'billing/payments.ts': 'export function chargeCard() {}\n',
      'README.md': '# Billing overview\nText.\n',
      'node_modules/x/index.js': 'x',
      'dist/out.js': 'y',
      'secret.txt': 'z',
      '.gitignore': 'secret.txt\n'
    });
    const { docs } = await buildFileIndex(root);
    assert.deepStrictEqual(docs.map(d => d.path), ['README.md', 'billing/payments.ts']);
  });

  await run('path tokens come from every path segment (stemmed); symbols come from the extractor', async () => {
    const root = project({ 'billing/payments.ts': 'export function chargeCard() {}\n' });
    const d = (await buildFileIndex(root)).docs[0];
    assert.ok(d.fields.path.includes('bill'), 'billing stems to bill');
    assert.ok(d.fields.path.includes('payment'), 'payments stems to payment');
    assert.ok(d.fields.symbols.includes('charge'));
    assert.ok(d.fields.symbols.includes('card'));
  });

  await run('summary is the first non-empty line of a markdown file, stripped of markup', async () => {
    const root = project({ 'docs/guide.md': '\n\n# Billing overview\nBody.\n' });
    const d = (await buildFileIndex(root)).docs[0];
    assert.ok(d.fields.summary.includes('bill'));
    assert.ok(d.fields.summary.includes('overview'));
  });

  await run('import edges use the same shape as The Link and resolve relative specifiers', async () => {
    const root = project({
      'a.ts': "import { b } from './b';\nexport const a = b;\n",
      'b.ts': 'export const b = 1;\n'
    });
    const { edges } = await buildFileIndex(root);
    assert.deepStrictEqual(edges, [{ from: 'a.ts', to: 'b.ts', rel: 'imports' }]);
  });

  await run('a file over the size cap is indexed by path only, its body never read', async () => {
    const big = 'export const x = "' + 'y'.repeat(MAX_FILE_BYTES + 10) + '";\n';
    const root = project({ 'huge/big.ts': big });
    const d = (await buildFileIndex(root)).docs.find(x => x.path === 'huge/big.ts');
    assert.ok(d, 'present');
    assert.deepStrictEqual(d.fields.symbols, []);
    assert.deepStrictEqual(d.fields.summary, []);
  });

  await run('a file with a NUL byte is indexed by path only', async () => {
    const root = project({ 'tools/blob.sh': 'hello\u0000world\n' });
    const d = (await buildFileIndex(root)).docs.find(x => x.path === 'tools/blob.sh');
    assert.ok(d);
    assert.deepStrictEqual(d.fields.summary, []);
  });

  await run('an empty project gives no documents and no edges', async () => {
    const root = project({});
    assert.deepStrictEqual(await buildFileIndex(root), { docs: [], edges: [], skipped: 0 });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/egc-guardian-filerank-index.test.js`
Expected: `Cannot find module .../file-index.js` after a build. Not green.

- [ ] **Step 3: Write the implementation**

First, in `mcp/servers/egc-guardian/src/graph-build.ts`, export the walker and widen the extension filter for text files. Change the `walk` signature and the extension test:

```ts
export const TEXT_EXT = /\.(?:[cm]?[jt]sx?|md|json|ya?ml|sh|txt|toml)$/i;
```

Replace the current `const SOURCE_EXT = ...;` line usage in `walk` with `TEXT_EXT` for the file check, and keep the JS/TS-only check where the graph store is fed (`buildGraph` only passes files matching `SOURCE_EXT`, so the graph remains JS/TS-only). Then change `async function walk(` to `export async function walkFiles(` and make `walkFiles` accept an extension test:

```ts
export async function walkFiles(
  root: string,
  ignore: IgnoreFn,
  accept: (name: string) => boolean,
  maxFiles: number,
  deadline: number
): Promise<{ files: string[]; truncated: boolean }>
```

Inside it, replace `SOURCE_EXT.test(e.name)` with `accept(e.name)`. Update the one call site in `buildGraph` to `walkFiles(root, ignore, name => SOURCE_EXT.test(name), maxFiles, deadline)`. Export `makeIgnore`, `resolveSpecifier` (already exported). Run `node tests/egc-graph-*` tests after this edit to confirm no regression.

Then create `mcp/servers/egc-guardian/src/file-index.ts`:

```ts
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
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractFile } from './graph-extract.js';
import { makeIgnore, resolveSpecifier, TEXT_EXT, walkFiles } from './graph-build.js';
import type { FileDoc, ImportEdge } from './file-ranker.js';
import { tokenize } from './file-ranker.js';

export const MAX_FILE_BYTES = 256 * 1024;
const JS_TS = /\.(?:[cm]?[jt]sx?)$/i;
const MAX_FILES = 5000;
const DEADLINE_MS = 20000;

function summaryOf(text: string): string {
  const line = text.split('\n').map(l => l.replace(/^[\s#*>/-]+/, '').trim()).find(l => l.length > 0);
  return line ?? '';
}

export async function buildFileIndex(
  projectRoot: string
): Promise<{ docs: FileDoc[]; edges: ImportEdge[]; skipped: number }> {
  const root = fs.realpathSync(projectRoot);
  let ignore = (_rel: string, _isDir: boolean): boolean => false;
  try {
    ignore = makeIgnore(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'));
  } catch {
    // no .gitignore
  }
  const walked = await walkFiles(root, ignore, name => TEXT_EXT.test(name), MAX_FILES, Date.now() + DEADLINE_MS);
  const docs: FileDoc[] = [];
  const jsTs = new Map<string, string>();
  let skipped = 0;
  const fileSet = new Set<string>(walked.files);

  for (const rel of walked.files) {
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(root, rel));
    } catch {
      skipped++;
      continue;
    }
    if (!st.isFile()) {
      skipped++;
      continue;
    }
    let text: string | null = null;
    if (st.size <= MAX_FILE_BYTES) {
      try {
        text = fs.readFileSync(path.join(root, rel), 'utf8');
      } catch {
        text = null;
      }
    }
    if (text !== null && text.includes('\u0000')) text = null;
    const pathTokens = tokenize(rel);
    if (text === null) {
      docs.push({ path: rel, fields: { path: pathTokens, symbols: [], keywords: [], summary: [] } });
      continue;
    }
    if (JS_TS.test(rel)) {
      jsTs.set(rel, text);
      const ex = extractFile(text);
      docs.push({
        path: rel,
        fields: {
          path: pathTokens,
          symbols: ex.symbols.flatMap(s => tokenize(s.name)),
          keywords: [],
          summary: tokenize(summaryOf(text))
        }
      });
    } else {
      docs.push({ path: rel, fields: { path: pathTokens, symbols: [], keywords: [], summary: tokenize(summaryOf(text)) } });
    }
  }

  const edges: ImportEdge[] = [];
  for (const [rel, text] of jsTs) {
    for (const im of extractFile(text).imports) {
      const target = resolveSpecifier(rel, im.specifier, fileSet);
      if (target && target !== rel) edges.push({ from: rel, to: target, rel: 'imports' });
    }
  }
  edges.sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : a.from + a.to > b.from + b.to ? 1 : 0));
  docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { docs, edges, skipped };
}
```

Note: `resolveSpecifier` returns a project-relative path with `/` separators, matching the walker's `childRel` form, so `edges` `to` values match `docs[].path`.

- [ ] **Step 4: Build, run, iterate until green**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-guardian-filerank-index.test.js
node tests/egc-guardian-graph-build.test.js
```

Expected: 7 `PASS` for the index test, `0 failed`, and the graph build suite still 10 `PASS`. `buildFileIndex` is async because the walker is.

- [ ] **Step 5: Commit**

```bash
git add mcp/servers/egc-guardian/src/file-index.ts mcp/servers/egc-guardian/src/graph-build.ts tests/egc-guardian-filerank-index.test.js
git commit -m "feat(guardian): index project files for ranking with symbols, imports and summaries"
```

---

### Task 6: Orchestrator, explain table and briefing

**Files:**
- Modify: `mcp/servers/egc-guardian/src/file-ranker.ts`
- Test: `tests/egc-guardian-filerank-briefing.test.js`

**Interfaces:**
- Consumes: `scoreDocuments` (Task 3), `collectGitContext` (Task 4), `buildFileIndex` (Task 5), `redactPayload` (`audit-log.ts`), `scanForInjection` (`prompt-injection-scanner.ts`).
- Produces:
  - `interface RankOptions { projectPath: string; query: string; history?: string; topN?: number; useGit?: boolean; weights?: Record<string, number>; graphHops?: number }`
  - `interface RankedFile { path: string; score: number; signals: Record<string, number> }`
  - `rankProjectFiles(opts: RankOptions): Promise<{ ranked: RankedFile[]; explain: string[]; briefing: string }>`
  - `renderExplain(files: RankedFile[]): string[]`
  - `renderBriefing(query: string, history: string, files: RankedFile[], projectPath: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/egc-guardian-filerank-briefing.test.js`:

```js
'use strict';
/**
 * rankProjectFiles ties the index, the git signal and the scorer together and
 * renders the explain table (stderr) and the three-block briefing (stdout).
 *
 * Run with: node tests/egc-guardian-filerank-briefing.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'file-ranker.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { rankProjectFiles, renderExplain, renderBriefing } = require(path.join(buildDir, 'file-ranker.js'));

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.stack || err.message}`);
    failed++;
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-filerank-brief-'));
const root = path.join(tmp, 'proj');
fs.mkdirSync(path.join(root, 'billing'), { recursive: true });
fs.writeFileSync(path.join(root, 'billing', 'payments.ts'), "import { fee } from './fees';\nexport function chargeCard() { return fee(); }\n");
fs.writeFileSync(path.join(root, 'billing', 'fees.ts'), 'export function fee() { return 1; }\n');
fs.writeFileSync(path.join(root, 'unrelated.ts'), 'export const color = "red";\n');

(async () => {
  await run('returns ranked files with per-signal breakdown, best first', async () => {
    const r = await rankProjectFiles({ projectPath: root, query: 'fix chargeCard payments', useGit: false });
    assert.strictEqual(r.ranked[0].path, 'billing/payments.ts');
    assert.ok(r.ranked[0].signals.bm25 > 0);
    assert.ok(r.ranked[0].signals.path_hit > 0);
  });

  await run('import propagation pulls the imported file in with a decayed contribution', async () => {
    const r = await rankProjectFiles({ projectPath: root, query: 'chargeCard', useGit: false });
    const fees = r.ranked.find(f => f.path === 'billing/fees.ts');
    assert.ok(fees && fees.signals.import_graph > 0, 'fees.ts reached through the import');
  });

  await run('explain table has a header, one row per file, and the signal columns', () => {
    const lines = renderExplain([{ path: 'a.ts', score: 2.5, signals: { bm25: 1.5, path_hit: 1.0 } }]);
    assert.ok(lines[0].startsWith('explain:'));
    assert.ok(lines.some(l => l.includes('bm25') && l.includes('path_hit')));
    assert.ok(lines.some(l => l.includes('a.ts') && l.includes('2.50')));
  });

  await run('briefing has the three blocks in order, with the request last', () => {
    const b = renderBriefing('fix chargeCard', 'decided to keep fees separate', [{ path: 'a.ts', score: 1, signals: {} }], root);
    const i1 = b.indexOf('[PROJECT HISTORY]');
    const i2 = b.indexOf('[RELEVANT CODEBASE CONTEXT]');
    const i3 = b.indexOf('[USER REQUEST]');
    assert.ok(i1 >= 0 && i1 < i2 && i2 < i3);
    assert.ok(b.endsWith('fix chargeCard'));
    assert.ok(b.includes('decided to keep fees separate'));
  });

  await run('briefing with no history says so, and with no files says so', () => {
    const b = renderBriefing('q', '   ', [], root);
    assert.ok(b.includes('(no session history found)'));
    assert.ok(b.includes('(no relevant files found)'));
  });

  await run('a history line that looks like a secret is redacted before printing', () => {
    const b = renderBriefing('q', 'note: api_key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', [], root);
    assert.ok(!b.includes('sk-ant-api03-AAAA'), 'secret is not printed');
  });

  await run('a query with no matches returns an empty ranking, not an error', async () => {
    const r = await rankProjectFiles({ projectPath: root, query: 'the and', useGit: false });
    assert.deepStrictEqual(r.ranked, []);
    assert.ok(r.briefing.includes('[USER REQUEST]'));
  });

  await run('no project files gives an empty ranking', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    const r = await rankProjectFiles({ projectPath: empty, query: 'anything', useGit: false });
    assert.deepStrictEqual(r.ranked, []);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/egc-guardian-filerank-briefing.test.js`
Expected: `rankProjectFiles is not a function`. Not green.

- [ ] **Step 3: Write the implementation**

Append to `mcp/servers/egc-guardian/src/file-ranker.ts`. Add these imports at the top of the file, below the header comment:

```ts
import { collectGitContext } from './file-git.js';
import { buildFileIndex } from './file-index.js';
import { redactPayload } from './audit-log.js';
import { scanForInjection } from './prompt-injection-scanner.js';
```

Then append:

```ts

export interface RankOptions {
  projectPath: string;
  query: string;
  history?: string;
  topN?: number;
  useGit?: boolean;
  weights?: Record<string, number>;
  graphHops?: number;
}
export interface RankedFile { path: string; score: number; signals: Record<string, number> }

export async function rankProjectFiles(opts: RankOptions): Promise<{ ranked: RankedFile[]; explain: string[]; briefing: string }> {
  const index = await buildFileIndex(opts.projectPath);
  const gitSignal = opts.useGit === false ? null : collectGitContext(opts.projectPath);
  const scored = scoreDocuments(index.docs, {
    query: opts.query,
    history: opts.history ?? '',
    edges: index.edges,
    extras: { gitSignal: gitSignal ?? undefined, graphHops: opts.graphHops }
  }, { weights: opts.weights, signals: gitSignal ? ['bm25', 'path_hit', 'git'] : undefined });

  const limit = Math.max(opts.topN ?? 10, 0);
  const ranked: RankedFile[] = scored.filter(sd => sd.total > 0).slice(0, limit).map(sd => ({
    path: sd.doc.path,
    score: Math.round(sd.total * 1000) / 1000,
    signals: Object.fromEntries(sd.signals.map(s => [s.name, Math.round(s.raw * s.weight * 1000) / 1000]))
  }));
  return {
    ranked,
    explain: renderExplain(ranked),
    briefing: renderBriefing(opts.query, opts.history ?? '', ranked)
  };
}

export function renderExplain(files: RankedFile[]): string[] {
  if (files.length === 0) return ['explain: no files ranked'];
  const names: string[] = [];
  for (const f of files) for (const n of Object.keys(f.signals)) if (!names.includes(n)) names.push(n);
  const header = ['#', 'score', ...names, 'path'];
  const rows: string[][] = [header, ...files.map((f, i) => [
    String(i + 1), f.score.toFixed(2), ...names.map(n => (f.signals[n] ?? 0).toFixed(2)), f.path
  ])];
  const widths = header.map((_, c) => Math.max(...rows.map(r => r[c].length)));
  const out = [`explain: ${files.length} file(s) ranked (signals: ${names.join(', ')})`];
  for (const r of rows) {
    const cells = r.slice(0, -1).map((cell, c) => cell.padStart(widths[c]));
    out.push('  ' + [...cells, r[r.length - 1]].join('  '));
  }
  return out;
}

function safeText(text: string): string {
  if (scanForInjection(text).length > 0) return '[omitted: flagged by prompt-injection scan]';
  return String(redactPayload({ text }).text);
}

export function renderBriefing(query: string, history: string, files: RankedFile[]): string {
  const historyBlock = history.trim() ? safeText(history.trim()) : '(no session history found)';
  const codeBlock = files.length === 0
    ? '(no relevant files found)'
    : files.map(f => `--- ${f.path} ---`).join('\n');
  return [
    '[PROJECT HISTORY]',
    historyBlock,
    '',
    '[RELEVANT CODEBASE CONTEXT]',
    codeBlock,
    '',
    '[USER REQUEST]',
    query
  ].join('\n');
}
```

Design note on the briefing: `renderBriefing` lists the ranked paths; it does not inline file contents. This keeps the default briefing small. Files with a total score of zero are dropped before the top-N cut, so a query with no matches gives an empty ranking rather than noise (ruling R6).

- [ ] **Step 4: Build, run, iterate until green**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-guardian-filerank-briefing.test.js
```

Expected: 8 `PASS`, `0 failed`. The `redactPayload` test relies on the redaction in `audit-log.ts` catching `sk-ant-` keys; if it does not, do not weaken the test: check `redactSecretsInText` covers `sk-ant-api` keys and fix the call in `passSafe` by passing the history through the same helper the audit log uses.

- [ ] **Step 5: Commit**

```bash
git add mcp/servers/egc-guardian/src/file-ranker.ts tests/egc-guardian-filerank-briefing.test.js
git commit -m "feat(guardian): rank project files, render the explain table and the three-block briefing"
```

---

### Task 7: `rank_files` MCP tool

**Files:**
- Modify: `mcp/servers/egc-guardian/src/index.ts`
- Test: `tests/egc-guardian-filerank-tool.test.js`

**Interfaces:**
- Consumes: `rankProjectFiles` (Task 6).
- Produces: MCP tool `rank_files` with input `{ query: string; project_path?: string; history?: string; top_n?: number; use_git?: boolean; graph_hops?: number; explain?: boolean }`, returning JSON text `{ ranked, briefing, explain? }`. `explain` lines are returned in the JSON, not written to stderr, because the MCP stdio channel is the protocol stream.

- [ ] **Step 1: Write the failing test**

Create `tests/egc-guardian-filerank-tool.test.js`:

```js
'use strict';
/**
 * The rank_files tool is reachable over the MCP stdio server and returns the
 * ranking, the briefing and (on request) the explain lines as JSON.
 *
 * Run with: node tests/egc-guardian-filerank-tool.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'index.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-filerank-tool-'));
const root = path.join(tmp, 'proj');
fs.mkdirSync(path.join(root, 'billing'), { recursive: true });
fs.writeFileSync(path.join(root, 'billing', 'payments.ts'), 'export function chargeCard() { return 1; }\n');
fs.writeFileSync(path.join(root, 'other.ts'), 'export const x = 1;\n');
const env = { ...process.env, EGC_DIR: path.join(tmp, 'egc-home') };

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.stack || err.message}`);
    failed++;
  }
}

function session() {
  const child = spawn(process.execPath, [path.join(buildDir, 'index.js')], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) pending.get(JSON.parse(line).id)?.(JSON.parse(line));
    }
  });
  const rpc = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 30000);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, rpc };
}

(async () => {
  await run('rank_files is listed with its input schema', async () => {
    const s = session();
    try {
      await s.rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const list = await s.rpc(2, 'tools/list', {});
      const tool = list.result.tools.find(t => t.name === 'rank_files');
      assert.ok(tool, 'rank_files listed');
      assert.deepStrictEqual(tool.inputSchema.required, ['query']);
      assert.ok(tool.inputSchema.properties.explain && tool.inputSchema.properties.project_path);
    } finally {
      s.child.kill();
    }
  });

  await run('rank_files returns ranked files, a briefing, and explain lines on request', async () => {
    const s = session();
    try {
      await s.rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const res = await s.rpc(3, 'tools/call', { name: 'rank_files', arguments: { query: 'chargeCard', project_path: root, use_git: false, explain: true } });
      const body = JSON.parse(res.result.content[0].text);
      assert.strictEqual(body.ranked[0].path, 'billing/payments.ts');
      assert.ok(body.briefing.includes('[USER REQUEST]'));
      assert.ok(Array.isArray(body.explain) && body.explain[0].startsWith('explain:'));
    } finally {
      s.child.kill();
    }
  });

  await run('rank_files without a query argument is an invalid-params error', async () => {
    const s = session();
    try {
      await s.rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const res = await s.rpc(4, 'tools/call', { name: 'rank_files', arguments: { project_path: root } });
      assert.ok(res.error || res.result.isError, 'rejected');
    } finally {
      s.child.kill();
    }
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/egc-guardian-filerank-tool.test.js`
Expected: the first test fails with `rank_files listed` (tool not registered). Not green.

- [ ] **Step 3: Write the implementation**

In `mcp/servers/egc-guardian/src/index.ts`:

1. Add the import next to the `graph-context.js` import:

```ts
import { rankProjectFiles } from './file-ranker.js';
```

2. Add a schema next to `OrchestrateTaskSchema`:

```ts
const RankFilesSchema = z.object({
  query: z.string(),
  project_path: z.string().optional(),
  history: z.string().optional(),
  top_n: z.number().int().min(1).max(50).optional(),
  use_git: z.boolean().optional(),
  graph_hops: z.number().int().min(0).max(4).optional(),
  explain: z.boolean().optional()
});
```

3. In the `tools` list in `ListToolsRequestSchema`, add the entry after `orchestrate_task`:

```ts
      {
        name: "rank_files",
        description: "Ranks the project's files for a task using four signals: BM25 over path, symbols, keywords and summary (weight 1.0), path hits (1.5), local git state (uncommitted, branch, recency, co-change; 1.0), and import-graph propagation two hops from the top files (1.2). Returns the ranking, a three-block briefing, and on request an explain table of each signal's contribution. Pass history from get_state so the briefing includes session decisions.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The task, in the user's words." },
            project_path: { type: "string", description: "Absolute project root. Defaults to the server's working directory." },
            history: { type: "string", description: "Session history to include under PROJECT HISTORY (e.g. the decisions from get_state)." },
            top_n: { type: "number", description: "How many files to return (1-50, default 10)." },
            use_git: { type: "boolean", description: "Include local git signals when the project is a repository (default true)." },
            graph_hops: { type: "number", description: "Import-graph hops from the top files (0-4, default 2; 0 disables)." },
            explain: { type: "boolean", description: "Include the explain table lines in the result." }
          },
          required: ["query"]
        }
      },
```

4. In the `CallToolRequestSchema` switch, add the case next to `orchestrate_task`:

```ts
      case "rank_files": return await handleRankFiles(request.params.arguments);
```

5. Add the handler after `handleOrchestrateTask`:

```ts
async function handleRankFiles(toolArgs: unknown) {
  const parsed = RankFilesSchema.parse(toolArgs);
  const result = await rankProjectFiles({
    projectPath: parsed.project_path ?? process.cwd(),
    query: parsed.query,
    history: parsed.history ? String(redactPayload({ text: parsed.history }).text) : '',
    topN: parsed.top_n,
    useGit: parsed.use_git ?? true,
    graphHops: parsed.graph_hops
  });
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ranked: result.ranked,
        briefing: result.briefing,
        ...(parsed.explain ? { explain: result.explain } : {})
      }, null, 2)
    }]
  };
}
```

The history is redacted here as well as in `renderBriefing`, so the secret never reaches the ranking object; `renderBriefing` redacts again, which is harmless.

- [ ] **Step 4: Build, run, iterate until green**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-guardian-filerank-tool.test.js
```

Expected: 3 `PASS`, `0 failed`. Also run `node tests/egc-guardian-graph-context.test.js` to confirm `orchestrate_task` is unchanged (8 `PASS`).

- [ ] **Step 5: Commit**

```bash
git add mcp/servers/egc-guardian/src/index.ts tests/egc-guardian-filerank-tool.test.js
git commit -m "feat(guardian): register the rank_files MCP tool"
```

---

### Task 8: `egc context` command

**Files:**
- Create: `scripts/context.js`
- Modify: `scripts/egc.js` (add a `context` entry in `COMMANDS` and in `PRIMARY_COMMANDS`)
- Test: `tests/egc-context-command.test.js`

**Interfaces:**
- Consumes: the compiled `rankProjectFiles` from `mcp/servers/egc-guardian/build/file-ranker.js`.
- Produces: `node scripts/context.js "<query>" [--project <dir>] [--history <file>|-] [--top <n>] [--no-git] [--explain]`. Briefing on stdout. Explain table on stderr when `--explain`. Exit 0 on success, 1 on bad arguments, 2 when the guardian build is missing.

- [ ] **Step 1: Write the failing test**

Create `tests/egc-context-command.test.js`:

```js
'use strict';
/**
 * `egc context` prints the three-block briefing on stdout and, with --explain,
 * the explain table on stderr. Bad arguments exit 1; a missing build exits 2.
 *
 * Run with: node tests/egc-context-command.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'context.js');
const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'file-ranker.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-context-cmd-'));
const root = path.join(tmp, 'proj');
fs.mkdirSync(path.join(root, 'billing'), { recursive: true });
fs.writeFileSync(path.join(root, 'billing', 'payments.ts'), 'export function chargeCard() { return 1; }\n');

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

run('prints the three-block briefing on stdout', () => {
  const r = spawnSync(process.execPath, [script, 'chargeCard', '--project', root, '--no-git'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[PROJECT HISTORY]'));
  assert.ok(r.stdout.includes('billing/payments.ts'));
  assert.ok(r.stdout.trimEnd().endsWith('chargeCard'));
  assert.strictEqual(r.stderr.trim(), '', 'no explain output without --explain');
});

run('--explain writes the table to stderr and leaves stdout as the briefing', () => {
  const r = spawnSync(process.execPath, [script, 'chargeCard', '--project', root, '--no-git', '--explain'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stderr.startsWith('explain:'));
  assert.ok(!r.stdout.includes('explain:'));
});

run('--history reads the history from a file', () => {
  const h = path.join(tmp, 'history.txt');
  fs.writeFileSync(h, 'decided: refunds stay in a separate module');
  const r = spawnSync(process.execPath, [script, 'refunds', '--project', root, '--no-git', '--history', h], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('refunds stay in a separate module'));
});

run('--history - reads the history from stdin', () => {
  const r = spawnSync(process.execPath, [script, 'refunds', '--project', root, '--no-git', '--history', '-'], { input: 'piped history', encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('piped history'));
});

run('no query is a usage error with exit 1', () => {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('usage'));
});

run('an unknown flag is a usage error with exit 1', () => {
  const r = spawnSync(process.execPath, [script, 'x', '--bogus'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
});

run('egc context routes to the script through the command table', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'egc.js'), 'help', 'context'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.toLowerCase().includes('context'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/egc-context-command.test.js`
Expected: the first run fails because `scripts/context.js` does not exist (`status` is not 0). Not green.

- [ ] **Step 3: Write the implementation**

Create `scripts/context.js`:

```js
#!/usr/bin/env node
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
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const USAGE = 'usage: egc context "<query>" [--project <dir>] [--history <file>|-] [--top <n>] [--no-git] [--explain]';

function parse(argv) {
  const opts = { query: null, project: process.cwd(), history: null, top: 10, git: true, explain: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--history') opts.history = argv[++i];
    else if (a === '--top') opts.top = Number(argv[++i]);
    else if (a === '--no-git') opts.git = false;
    else if (a === '--explain') opts.explain = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (opts.query === null) opts.query = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (opts.help) return opts;
  if (!opts.query || !opts.query.trim()) throw new Error('missing query');
  if (!Number.isInteger(opts.top) || opts.top < 1 || opts.top > 50) throw new Error('--top must be 1-50');
  return opts;
}

function readHistory(spec) {
  if (!spec) return '';
  if (spec === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(spec, 'utf8');
}

async function main() {
  let opts;
  try {
    opts = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'file-ranker.js');
  if (!fs.existsSync(buildPath)) {
    process.stderr.write('egc context: guardian build not found; run npm run build in mcp/servers/egc-guardian\n');
    return 2;
  }
  const { rankProjectFiles } = await import(require('node:url').pathToFileURL(buildPath).href);
  const result = await rankProjectFiles({
    projectPath: path.resolve(opts.project),
    query: opts.query,
    history: readHistory(opts.history),
    topN: opts.top,
    useGit: opts.git
  });
  process.stdout.write(result.briefing + '\n');
  if (opts.explain) process.stderr.write(result.explain.join('\n') + '\n');
  return 0;
}

main().then(code => { process.exitCode = code; });
```

Note the `await import(...)` of a file path: the guardian build is ESM (`"type": "module"`), and `scripts/` is CommonJS, so a dynamic `import()` of the built file is required, not `require`.

In `scripts/egc.js`, add to `COMMANDS` (next to `gain`) and to `PRIMARY_COMMANDS`:

```js
  context: {
    script: 'context.js',
    description: 'Rank the project files for a task and print the briefing (--explain for the signal table)'
  },
```

Add `'context'` to `PRIMARY_COMMANDS` after `'gain'`. Use the existing entry shape in `COMMANDS`, matching the neighbouring entries exactly (read the `gain` entry first and copy its keys).

- [ ] **Step 4: Build, run, iterate until green**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-context-command.test.js
npm test
```

Expected: 7 `PASS`, `0 failed`; the full `npm test` still passes (the command-table test `scripts/ci/validate-commands.js` checks every `COMMANDS` entry, so the new entry must match the others' shape).

- [ ] **Step 5: Commit**

```bash
git add scripts/context.js scripts/egc.js tests/egc-context-command.test.js
git commit -m "feat(cli): add egc context to print the file-ranking briefing"
```

---

### Task 9: Real-world check on this repository

**Files:**
- Create: `tests/egc-guardian-filerank-selfbench.test.js`

**Interfaces:**
- Consumes: `rankProjectFiles` (Task 6).

- [ ] **Step 1: Write the benchmark test**

Create `tests/egc-guardian-filerank-selfbench.test.js`. Each case names a task a maintainer would plausibly give and the file they would open first; the test checks it is in the top 10. This is the issue's "relevant files in top 10" criterion:

```js
'use strict';
/**
 * Real-world check on this repository: for maintainer-style tasks, the file a
 * maintainer would open first is in the top 10 ranked files.
 *
 * Run with: node tests/egc-guardian-filerank-selfbench.test.js
 */
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'file-ranker.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

const CASES = [
  ['classify a chunk as json, code, log or diff before crushing it', 'egc-chunk-router.ts'],
  ['the prompt injection scanner should flag a new pattern', 'prompt-injection-scanner.ts'],
  ['validateCommand denies a dangerous git command', 'validator.ts'],
  ['write an audit log entry with redacted secrets', 'audit-log.ts'],
  ['the session bus announce and claim path functions', 'session-bus.ts'],
  ['search the memory history for past decisions', 'search.ts']
];

(async () => {
  const { rankProjectFiles } = require(buildPath);
  const repo = path.resolve(__dirname, '..', 'mcp', 'servers');
  let failed = 0;
  for (const [query, expected] of CASES) {
    const r = await rankProjectFiles({ projectPath: repo, query, useGit: false, topN: 10 });
    const top = r.ranked.map(f => path.basename(f.path));
    const ok = top.includes(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'} "${query}" -> ${expected} in top 10`);
    if (!ok) failed++;
  }
  console.log(`\n${CASES.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run it**

Run: `node tests/egc-guardian-filerank-selfbench.test.js`
Expected: at least 5 of 6 pass. For any miss, check the expected file really contains the task's words; fix the case if it was badly chosen. Do not change weights to fit the benchmark. Record the explain table of any miss in the PR description.

- [ ] **Step 3: Explain table for the PR**

Run once, by hand, for the PR description:

```bash
node scripts/context.js "classify a chunk as json code log or diff before crushing it" --project mcp/servers --no-git --explain > /dev/null
```

Expected: an explain table on stderr with a row for `egc-chunk-router.ts` near the top.

- [ ] **Step 4: Commit**

```bash
git add tests/egc-guardian-filerank-selfbench.test.js
git commit -m "test(guardian): check file ranking surfaces the expected files in the top 10"
```

---

### Task 10: Attribution, documentation and the cross-platform gate

**Files:**
- Modify: `NOTICE`, `CHANGELOG.md`, `docs/token-optimization.md`

- [ ] **Step 1: Attribution in NOTICE**

Read `NOTICE`, then append a section in its existing style:

```
The file ranking in mcp/servers/egc-guardian/src/file-ranker.ts, file-git.ts and file-index.ts, and scripts/context.js, is a TypeScript and Node port of The Link (https://github.com/UnforGBeast/thelink, commit 4f607a4217e2fe5e6a8c9a07187058b96acb6c3f), Copyright 2024 The Link Authors, licensed under the Apache License, Version 2.0. The scoring signals, the BM25 field weights, the import-graph propagation and the local-git signal follow thelink/scoring.py and thelink/gitsignals.py.
```

- [ ] **Step 2: CHANGELOG entry**

Under `## [Unreleased]` / `### Added`, add in the file's existing style (one bold lead, one paragraph):

```markdown
- **`rank_files` and `egc context` rank a project's files for a task** (#1386, a port of The Link, credited in NOTICE): four signals combine into one ranking, BM25 over path, symbols, keywords and summary (weight 1.0), path hits on task words (1.5), local git state with a 5 second timeout (uncommitted, branch, recency, co-change; 1.0), and import-graph propagation two hops from the top five files (1.2). `rank_files` returns the ranking, a three-block briefing (`[PROJECT HISTORY]`, `[RELEVANT CODEBASE CONTEXT]`, `[USER REQUEST]`), and on request an explain table of each signal's contribution. `egc context` prints the briefing and, with `--explain`, the table on stderr. Node built-ins only, no network, deterministic output; the history comes from the caller, never from the encrypted state files.
```

- [ ] **Step 3: Documentation**

In `docs/token-optimization.md`, after the paragraph that describes `relevant_context`, add one sentence: `rank_files` and `egc context` rank the project's files for a task (BM25, path hits, local git state, import-graph propagation) and print the briefing; `--explain` shows how each signal contributed. Keep the page's prose style: no double hyphens or dashes as punctuation.

- [ ] **Step 4: Cross-platform gate**

Run `node tests/run-all.js` on Linux and macOS through CI (the repository matrix), and on Windows locally. The filerank tests must pass on all three. Record the three results in the PR description.

- [ ] **Step 5: Commit**

```bash
git add NOTICE CHANGELOG.md docs/token-optimization.md
git commit -m "docs(guardian): credit The Link and document rank_files and egc context"
```

---

## Self-Review

- **Issue coverage:** four signals with the specified weights (Tasks 2–4); explain table (Task 6, Task 8, Task 9); three-block briefing (Task 6, Task 8); `rank_files` tool (Task 7); `egc context` (Task 8); `file-index.ts` (Task 5); `file-ranker.ts` (Tasks 1–3, 6); `scripts/context.js` (Task 8); tests (every task); Apache headers (every new source file); NOTICE and CHANGELOG (Task 10); no GrapeRoot and no `reader.py` (not used anywhere); no new dependencies (Node built-ins only); no changes to `validate_command`, Token Crusher, or state schema (none touched); 5 second git timeout (Task 4); cross-platform (Task 10 gate).
- **Deviations from the issue, recorded as rulings R1–R5 above.**
- **Interfaces:** `FileDoc`, `ImportEdge`, `ScoreContext`, `GitContextLike`, `RankedFile`, `rankProjectFiles`, `renderExplain`, `renderBriefing` are each defined once (Tasks 3, 4, 6) and used with the same names in later tasks.
- **Known risk:** The Link's `path_hit` and `expand` behaviour is ported from the source at the pinned commit; if a test expectation disagrees with the port, the port is checked against the source at `4f607a4`, not the test relaxed.
