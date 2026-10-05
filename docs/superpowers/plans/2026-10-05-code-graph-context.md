# Code Graph Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `orchestrate_task` returns a `relevant_context` block: ranked snippets of the project's own JS/TS code, picked from a locally built graph of files, symbols, imports and references.

**Architecture:** Four focused modules in `mcp/servers/egc-guardian/src/` (extract, store, build, query) plus one thin wrapper (`graph-context.ts`) that `handleOrchestrateTask` calls. The graph is cached in SQLite under `~/.egc/graph/`, built lazily and refreshed incrementally. Nothing in the graph modules imports `index.ts` (which has top-level await), so tests `require` the built files directly, like the other guardian tests.

**Tech Stack:** TypeScript (ESM, Node16 modules), the existing `sqlite-compat.ts` engine chooser, node:test-free plain assert scripts run by `tests/run-all.js`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-05-code-graph-context-design.md`

## Global Constraints

- No new runtime dependency in `mcp/servers/egc-guardian/package.json` (no tree-sitter, no embeddings, no network).
- JS/TS only: `.js .jsx .mjs .cjs .ts .tsx .mts .cts`.
- Graph modules must not import `./index.js` and must have no top-level await.
- DB location: `~/.egc/graph/<slug>-<hash>.db`; `EGC_DIR` (if set) moves it to `$EGC_DIR/egc/graph/`.
- Build caps: 5000 files, 20 seconds, 1 MB per file. Query defaults: budget 2000 tokens (chars/4), 8 seeds, 2 hops, 0.5x decay per hop.
- Symlinks are never followed during the walk; `.git`, `node_modules`, build output, `.env*`-style protected files and root `.gitignore` matches are never indexed.
- Snippet text must pass the injection scanner and secret redaction before it is returned; audit events carry counts and timings only, never snippet text.
- `orchestrate_task` must never fail because of the graph: any graph error becomes `relevant_context: { status: "unavailable", reason }`.
- Source style: single quotes, semicolons, 2-space indent, no comments except a short line for a non-obvious why.
- Tests: plain `node:assert` scripts named `tests/egc-guardian-graph-*.test.js` that print `[SKIP]` and exit 0 when `mcp/servers/egc-guardian/build` is missing.

## Review Focus

- A prompt with no usable words (empty, stopwords only, punctuation): returns `files: []`, not an error (Task 4 test).
- A file that does not parse (binary junk, unbalanced braces, a 1 MB minified bundle): that file yields an empty or partial result and the build continues (Task 1 and 3 tests).
- A project path that is a filesystem root, the home directory, a file, or missing: `unavailable`, never a walk (Task 5 test).
- Two `orchestrate_task` calls at once on a cold project: one builds, the other returns without error (Task 3 lock test, Task 5 test).
- A corrupt or old-schema graph database: rebuilt once, transparently (Task 2 and 5 tests).

---

## File Structure

| File | Responsibility |
|---|---|
| `mcp/servers/egc-guardian/src/graph-extract.ts` | Pure lexer/extractor: source text to symbols, imports, refs. |
| `mcp/servers/egc-guardian/src/graph-store.ts` | SQLite persistence, DB path, schema versioning, corruption recovery. |
| `mcp/servers/egc-guardian/src/graph-build.ts` | Walk, ignore rules, incremental refresh, import resolution, edge computation, build lock. |
| `mcp/servers/egc-guardian/src/graph-query.ts` | Seeding, expansion, budget trim, snippet cutting. |
| `mcp/servers/egc-guardian/src/graph-context.ts` | Wrapper used by `orchestrate_task`: safety checks, lock, degrade-to-unavailable, audit. |
| `mcp/servers/egc-guardian/src/index.ts` | Modify: schema args, tool description, call wrapper. |
| `tests/egc-guardian-graph-*.test.js` | One test file per module plus an integration/benchmark file. |
| `docs/token-optimization.md`, `CHANGELOG.md` | Document the feature. |

Build and run commands used throughout (from the repo root):

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-guardian-graph-extract.test.js
```

If `mcp/servers/egc-guardian/node_modules` is missing, run `npm --prefix mcp/servers/egc-guardian ci` once first.

---

### Task 1: Lexical extractor

**Files:**
- Create: `mcp/servers/egc-guardian/src/graph-extract.ts`
- Test: `tests/egc-guardian-graph-extract.test.js`

**Interfaces:**
- Produces:
  - `type SymbolKind = 'function' | 'class' | 'variable' | 'method' | 'type'`
  - `interface ExtractedSymbol { name: string; kind: SymbolKind; exported: boolean; startLine: number; endLine: number; refs: string[] }`
  - `interface ImportBinding { local: string; imported: string }` (`imported` is a name, `'default'` or `'*'`)
  - `interface ExtractedImport { specifier: string; bindings: ImportBinding[]; reexport: boolean }`
  - `interface ExtractResult { symbols: ExtractedSymbol[]; imports: ExtractedImport[] }`
  - `function extractFile(source: string): ExtractResult` (never throws)
  - Ref strings: `name` (plain identifier), `ns.member` (member of a plain identifier), `.member` (a `this.member` access).

- [ ] **Step 1: Write the failing test**

Create `tests/egc-guardian-graph-extract.test.js`:

```js
'use strict';
/**
 * The graph extractor reads JS/TS source as text and reports its symbols,
 * imports and references without running or fully parsing it.
 *
 * Run with: node tests/egc-guardian-graph-extract.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'graph-extract.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { extractFile } = require(buildPath);

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
const sym = (r, name) => r.symbols.find(s => s.name === name);

const ES = [
  "import def, { a, b as c } from './mod.js';",
  'import * as ns from "../lib/util";',
  "import './side-effect';",
  "export { x as y } from './re';",
  "export * from './all';",
  'export function foo(a) { return a + helper(c) + ns.run(); }',
  'export default class Widget { render() { return foo(1); } static make() { return new Widget(); } }',
  'const helper = (v) => v * 2;',
  'export const answer = 42;'
].join('\n');

run('ES imports and re-exports', () => {
  const r = extractFile(ES);
  assert.deepStrictEqual(r.imports.map(i => i.specifier), ['./mod.js', '../lib/util', './side-effect', './re', './all']);
  assert.deepStrictEqual(r.imports[0].bindings, [
    { local: 'def', imported: 'default' },
    { local: 'a', imported: 'a' },
    { local: 'c', imported: 'b' }
  ]);
  assert.deepStrictEqual(r.imports[1].bindings, [{ local: 'ns', imported: '*' }]);
  assert.strictEqual(r.imports[3].reexport, true);
  assert.deepStrictEqual(r.imports[3].bindings, [{ local: 'y', imported: 'x' }]);
  assert.deepStrictEqual(r.imports[4].bindings, [{ local: '*', imported: '*' }]);
});

run('ES symbols, kinds, export flags and line ranges', () => {
  const r = extractFile(ES);
  assert.deepStrictEqual(r.symbols.map(s => s.name), ['foo', 'Widget', 'Widget.render', 'Widget.make', 'helper', 'answer']);
  assert.strictEqual(sym(r, 'foo').kind, 'function');
  assert.strictEqual(sym(r, 'foo').exported, true);
  assert.strictEqual(sym(r, 'foo').startLine, 6);
  assert.strictEqual(sym(r, 'foo').endLine, 6);
  assert.strictEqual(sym(r, 'Widget').kind, 'class');
  assert.strictEqual(sym(r, 'Widget.render').kind, 'method');
  assert.strictEqual(sym(r, 'Widget.render').exported, true);
  assert.strictEqual(sym(r, 'helper').kind, 'function');
  assert.strictEqual(sym(r, 'helper').exported, false);
  assert.strictEqual(sym(r, 'answer').kind, 'variable');
});

run('references: plain, namespace member, this member', () => {
  const r = extractFile(ES + '\nexport class K { a() { return this.b(); } b() { return 1; } }');
  assert.ok(sym(r, 'foo').refs.includes('helper'));
  assert.ok(sym(r, 'foo').refs.includes('c'));
  assert.ok(sym(r, 'foo').refs.includes('ns.run'));
  assert.ok(sym(r, 'Widget.render').refs.includes('foo'));
  assert.ok(sym(r, 'K.a').refs.includes('.b'));
  assert.ok(!sym(r, 'foo').refs.includes('foo'), 'a symbol does not reference itself');
});

run('CommonJS require, destructuring, module.exports, dynamic import', () => {
  const src = [
    "const fs = require('node:fs');",
    "const { read, write: put } = require('./io');",
    'function load(p) { return read(p); }',
    'module.exports = { load, put };',
    'exports.extra = function () { return fs; };',
    "const lazy = () => import('./lazy.js');"
  ].join('\n');
  const r = extractFile(src);
  const bySpec = Object.fromEntries(r.imports.map(i => [i.specifier, i.bindings]));
  assert.deepStrictEqual(bySpec['node:fs'], [{ local: 'fs', imported: '*' }]);
  assert.deepStrictEqual(bySpec['./io'], [{ local: 'read', imported: 'read' }, { local: 'put', imported: 'write' }]);
  assert.deepStrictEqual(bySpec['./lazy.js'], []);
  assert.strictEqual(sym(r, 'load').exported, true);
  assert.strictEqual(sym(r, 'extra').exported, true);
  assert.strictEqual(sym(r, 'lazy').kind, 'function');
  assert.strictEqual(sym(r, 'fs'), undefined, 'a require binding is an import, not a symbol');
});

run('keywords inside comments, strings, templates and regex literals are ignored', () => {
  const src = [
    "// import fake from './nope';",
    '/* export function ghost() {} */',
    "const s = \"import x from './str'\";",
    'const t = `export function tpl() {} ${ fn("}") } ${`nested ${1}`}`;',
    'const r = /export function re() {}\\//g;',
    'export function real() { return s + t + r; }'
  ].join('\n');
  const r = extractFile(src);
  assert.strictEqual(r.imports.length, 0);
  assert.deepStrictEqual(r.symbols.map(s => s.name), ['s', 't', 'r', 'real']);
});

run('multi-line ranges for functions and arrow constants', () => {
  const src = 'export function a() {\n  return 1;\n}\n\nexport const b = () => {\n  return 2;\n};\n';
  const r = extractFile(src);
  assert.deepStrictEqual([sym(r, 'a').startLine, sym(r, 'a').endLine], [1, 3]);
  assert.deepStrictEqual([sym(r, 'b').startLine, sym(r, 'b').endLine], [5, 7]);
});

run('TypeScript interface, type, enum, abstract class, typed arrow', () => {
  const src = [
    'export interface Opts { a: string }',
    'export type Id = string;',
    'export enum Color { Red }',
    'export abstract class Base { abstract run(): void; go(): void { return; } }',
    'export const f = (a: number): number => { return a; };'
  ].join('\n');
  const r = extractFile(src);
  assert.deepStrictEqual(r.symbols.map(s => [s.name, s.kind]), [
    ['Opts', 'type'], ['Id', 'type'], ['Color', 'type'], ['Base', 'class'], ['Base.go', 'method'], ['f', 'function']
  ]);
});

run('malformed input never throws', () => {
  for (const src of ['', 'export function (( {{', '}}}}', 'import {', 'class {', '`unterminated', '/* open', 'const x = "open\nconst y = 1;', '\u0000\u0001\u0002']) {
    const r = extractFile(src);
    assert.ok(Array.isArray(r.symbols) && Array.isArray(r.imports));
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/egc-guardian-graph-extract.test.js`
Expected: prints `[SKIP] build not found...` or, if a build exists, fails with `Cannot find module .../graph-extract.js`. Either way the suite is not green yet; the failure that matters comes after Step 3's build.

- [ ] **Step 3: Write the implementation**

Create `mcp/servers/egc-guardian/src/graph-extract.ts`:

```ts
export type SymbolKind = 'function' | 'class' | 'variable' | 'method' | 'type';

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  startLine: number;
  endLine: number;
  refs: string[];
}
export interface ImportBinding { local: string; imported: string }
export interface ExtractedImport { specifier: string; bindings: ImportBinding[]; reexport: boolean }
export interface ExtractResult { symbols: ExtractedSymbol[]; imports: ExtractedImport[] }

interface Tok { t: 'id' | 'str' | 'lit' | 'p'; v: string; line: number }

const MAX_SYMBOLS = 2000;
const MAX_REFS = 200;

const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const DECL_START = new Set(['export', 'import', 'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'abstract', 'declare', 'async', 'module', 'exports', 'namespace']);
const CONTINUATION = new Set(['=', '+', '-', '*', '/', '%', '&', '|', '^', '?', ':', ',', '.', '<', '>', '!', '~', '(', '[', '{']);
const NON_REF = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'await', 'async', 'true', 'false', 'null', 'undefined', 'as', 'from', 'type', 'interface', 'enum',
  'implements', 'public', 'private', 'protected', 'readonly', 'abstract', 'declare', 'string', 'number', 'boolean', 'any', 'unknown', 'never'
]);

const isIdStart = (c: string): boolean => /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127;
const isIdPart = (c: string): boolean => /[\w$]/.test(c) || c.charCodeAt(0) > 127;
const isOpen = (tk?: Tok): boolean => !!tk && tk.t === 'p' && (tk.v === '{' || tk.v === '(' || tk.v === '[');
const isId = (tk: Tok | undefined, v?: string): boolean => !!tk && tk.t === 'id' && (v === undefined || tk.v === v);
const isP = (tk: Tok | undefined, v: string): boolean => !!tk && tk.t === 'p' && tk.v === v;

function regexAllowed(prev: Tok | undefined): boolean {
  if (!prev) return true;
  if (prev.t === 'id') return REGEX_AFTER_KEYWORD.has(prev.v);
  if (prev.t === 'str' || prev.t === 'lit') return false;
  return prev.v !== ')' && prev.v !== ']' && prev.v !== '}';
}

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;

  function skipString(q: string): string {
    i++;
    let v = '';
    while (i < n && src[i] !== q && src[i] !== '\n') {
      if (src[i] === '\\') {
        if (src[i + 1] === '\n') line++;
        v += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      v += src[i];
      i++;
    }
    if (src[i] === q) i++;
    return v;
  }
  function skipTemplate(): void {
    i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        if (src[i + 1] === '\n') line++;
        i += 2;
        continue;
      }
      if (src[i] === '\n') line++;
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        skipInterpolation();
        continue;
      }
      i++;
    }
    i++;
  }
  function skipInterpolation(): void {
    let depth = 1;
    while (i < n && depth > 0) {
      const d = src[i];
      if (d === '`') { skipTemplate(); continue; }
      if (d === '"' || d === "'") { skipString(d); continue; }
      if (d === '\n') line++;
      if (d === '{') depth++;
      else if (d === '}') depth--;
      i++;
    }
  }

  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const at = line;
      toks.push({ t: 'str', v: skipString(c), line: at });
      continue;
    }
    if (c === '`') {
      const at = line;
      skipTemplate();
      toks.push({ t: 'lit', v: '', line: at });
      continue;
    }
    if (c === '/' && regexAllowed(toks[toks.length - 1])) {
      const at = line;
      let inClass = false;
      i++;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; break; }
        i++;
      }
      while (i < n && /[a-z]/.test(src[i])) i++;
      toks.push({ t: 'lit', v: '', line: at });
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      toks.push({ t: 'lit', v: '', line });
      i = j;
      continue;
    }
    toks.push({ t: 'p', v: c, line });
    i++;
  }
  return toks;
}

function pairBrackets(toks: Tok[]): number[] {
  const match = new Array<number>(toks.length).fill(-1);
  const stack: number[] = [];
  toks.forEach((tk, k) => {
    if (tk.t !== 'p') return;
    if (tk.v === '{' || tk.v === '(' || tk.v === '[') {
      stack.push(k);
    } else if (tk.v === '}' || tk.v === ')' || tk.v === ']') {
      const open = stack.pop();
      if (open !== undefined) {
        match[open] = k;
        match[k] = open;
      }
    }
  });
  return match;
}

export function extractFile(source: string): ExtractResult {
  const toks = tokenize(source);
  const match = pairBrackets(toks);
  const last = toks.length - 1;
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const exportedNames = new Set<string>();

  // An unmatched opener counts as running to the end of the file.
  const close = (k: number): number => (match[k] >= 0 ? match[k] : last);

  const collectRefs = (from: number, to: number, self: string): string[] => {
    const refs = new Set<string>();
    for (let k = from; k <= to && refs.size < MAX_REFS; k++) {
      const tk = toks[k];
      if (tk.t !== 'id' || NON_REF.has(tk.v)) continue;
      if (isP(toks[k - 1], '.')) {
        if (isId(toks[k - 2], 'this')) refs.add('.' + tk.v);
        continue;
      }
      if (tk.v !== self) refs.add(tk.v);
      if (isP(toks[k + 1], '.') && isId(toks[k + 2])) refs.add(tk.v + '.' + toks[k + 2].v);
    }
    return [...refs];
  };

  const addSymbol = (name: string, kind: SymbolKind, exported: boolean, startIdx: number, endIdx: number, selfName: string = name): void => {
    if (symbols.length >= MAX_SYMBOLS) return;
    symbols.push({ name, kind, exported, startLine: toks[startIdx].line, endLine: toks[endIdx].line, refs: collectRefs(startIdx, endIdx, selfName) });
  };

  const statementEnd = (from: number): number => {
    let k = from;
    while (k <= last) {
      const tk = toks[k];
      if (k > from) {
        const prev = toks[k - 1];
        const continues = prev.t === 'p' && CONTINUATION.has(prev.v);
        if (tk.line > prev.line && tk.t === 'id' && DECL_START.has(tk.v) && !continues) return k - 1;
      }
      if (isP(tk, ';')) return k;
      k = isOpen(tk) ? close(k) + 1 : k + 1;
    }
    return last;
  };

  const readBraceBindings = (open: number, sep: 'as' | ':'): ImportBinding[] => {
    const out: ImportBinding[] = [];
    const end = close(open);
    let m = open + 1;
    while (m < end) {
      let nm = toks[m];
      if (isId(nm, 'type') && isId(toks[m + 1]) && !isId(toks[m + 1], 'as')) {
        m++;
        nm = toks[m];
      }
      if (!isId(nm)) { m++; continue; }
      const hasAlias = sep === 'as' ? isId(toks[m + 1], 'as') : isP(toks[m + 1], ':');
      const aliasAt = m + 2;
      if (hasAlias && isId(toks[aliasAt])) {
        out.push({ local: toks[aliasAt].v, imported: nm.v });
        m += 3;
      } else {
        out.push({ local: nm.v, imported: nm.v });
        m++;
      }
    }
    return out;
  };

  const requireSpecifier = (eq: number): string | null =>
    isP(toks[eq], '=') && isId(toks[eq + 1], 'require') && isP(toks[eq + 2], '(') && toks[eq + 3]?.t === 'str' ? toks[eq + 3].v : null;

  const isFunctionInit = (eq: number): boolean => {
    if (!isP(toks[eq], '=')) return false;
    const a = toks[eq + 1];
    if (isId(a, 'function') || isId(a, 'async')) return true;
    if (isP(a, '(') && match[eq + 1] >= 0) {
      const stop = Math.min(last, match[eq + 1] + 40);
      for (let m = match[eq + 1] + 1; m <= stop; m++) {
        if (isP(toks[m], ';')) return false;
        if (isP(toks[m], '=') && isP(toks[m + 1], '>')) return true;
      }
      return false;
    }
    return isId(a) && isP(toks[eq + 2], '=') && isP(toks[eq + 3], '>');
  };

  const addMethods = (cls: string, bodyOpen: number, exported: boolean): void => {
    const bodyClose = close(bodyOpen);
    let k = bodyOpen + 1;
    while (k < bodyClose) {
      const tk = toks[k];
      if (isId(tk) && isP(toks[k + 1], '(') && match[k + 1] >= 0) {
        let m = match[k + 1] + 1;
        while (m < bodyClose && !isP(toks[m], '{') && !isP(toks[m], ';')) m = isOpen(toks[m]) ? close(m) + 1 : m + 1;
        if (m < bodyClose && isP(toks[m], '{')) {
          const end = close(m);
          addSymbol(`${cls}.${tk.v}`, 'method', exported, k, end, tk.v);
          k = end + 1;
          continue;
        }
      }
      k = isOpen(tk) ? close(k) + 1 : k + 1;
    }
  };

  const parseImport = (i: number): number => {
    let j = i + 1;
    if (isId(toks[j], 'type') && (isId(toks[j + 1]) || isP(toks[j + 1], '{') || isP(toks[j + 1], '*')) && !isId(toks[j + 1], 'from')) j++;
    if (toks[j]?.t === 'str') {
      imports.push({ specifier: toks[j].v, bindings: [], reexport: false });
      return j + 1;
    }
    const bindings: ImportBinding[] = [];
    let k = j;
    while (k <= last && !isId(toks[k], 'from') && toks[k].t !== 'str') {
      const tk = toks[k];
      if (tk.t === 'id') {
        bindings.push({ local: tk.v, imported: 'default' });
        k++;
      } else if (isP(tk, '*')) {
        if (isId(toks[k + 2])) bindings.push({ local: toks[k + 2].v, imported: '*' });
        k += 3;
      } else if (isP(tk, '{')) {
        bindings.push(...readBraceBindings(k, 'as'));
        k = close(k) + 1;
      } else {
        k++;
      }
    }
    if (isId(toks[k], 'from')) k++;
    if (toks[k]?.t === 'str') {
      imports.push({ specifier: toks[k].v, bindings, reexport: false });
      return k + 1;
    }
    return Math.max(k, i + 1);
  };

  const parseCommonJs = (i: number, p: number): number => {
    if (isP(toks[p], '=')) {
      const rhs = p + 1;
      if (isP(toks[rhs], '{')) {
        const end = close(rhs);
        for (let k = rhs + 1; k < end; ) {
          const tk = toks[k];
          if (isId(tk)) {
            exportedNames.add(tk.v);
            if (isP(toks[k + 1], ':') && isId(toks[k + 2])) exportedNames.add(toks[k + 2].v);
          }
          k = isOpen(tk) ? close(k) + 1 : k + 1;
        }
      } else if (isId(toks[rhs]) && (isP(toks[rhs + 1], ';') || toks[rhs + 1] === undefined || toks[rhs + 1].line > toks[rhs].line)) {
        exportedNames.add(toks[rhs].v);
      }
      return statementEnd(i) + 1;
    }
    if (isP(toks[p], '.') && isId(toks[p + 1]) && isP(toks[p + 2], '=')) {
      const end = statementEnd(i);
      exportedNames.add(toks[p + 1].v);
      addSymbol(toks[p + 1].v, 'variable', true, i, end);
      return end + 1;
    }
    return i + 1;
  };

  const parseTopLevel = (i: number): number => {
    const tk = toks[i];
    if (isId(tk, 'import') && !isP(toks[i + 1], '(') && !isP(toks[i + 1], '.')) return parseImport(i);
    if (isId(tk, 'module') && isP(toks[i + 1], '.') && isId(toks[i + 2], 'exports')) return parseCommonJs(i, i + 3);
    if (isId(tk, 'exports') && isP(toks[i + 1], '.')) return parseCommonJs(i, i + 1);

    let j = i;
    let exported = false;
    let isDefault = false;
    if (isId(tk, 'export')) {
      exported = true;
      j++;
      if (isP(toks[j], '*')) {
        let k = j + 1;
        let ns: string | undefined;
        if (isId(toks[k], 'as') && isId(toks[k + 1])) {
          ns = toks[k + 1].v;
          k += 2;
        }
        if (isId(toks[k], 'from') && toks[k + 1]?.t === 'str') {
          imports.push({ specifier: toks[k + 1].v, bindings: [{ local: ns ?? '*', imported: '*' }], reexport: true });
          return k + 2;
        }
        return Math.max(k, i + 1);
      }
      if (isId(toks[j], 'type') && isP(toks[j + 1], '{')) j++;
      if (isP(toks[j], '{')) {
        const names = readBraceBindings(j, 'as');
        const k = close(j) + 1;
        if (isId(toks[k], 'from') && toks[k + 1]?.t === 'str') {
          imports.push({ specifier: toks[k + 1].v, bindings: names, reexport: true });
          return k + 2;
        }
        names.forEach(b => exportedNames.add(b.imported));
        return k;
      }
      if (isId(toks[j], 'default')) {
        isDefault = true;
        j++;
      }
    }
    while (isId(toks[j]) && ['declare', 'abstract', 'async'].includes(toks[j].v) && toks[j + 1]) j++;

    const d = toks[j];
    if (isId(d, 'function')) {
      let k = j + 1;
      if (isP(toks[k], '*')) k++;
      const nameTok = isId(toks[k]) ? toks[k] : undefined;
      let p = nameTok ? k + 1 : k;
      while (p <= last && !isP(toks[p], '(')) p++;
      let b = p <= last ? close(p) + 1 : last + 1;
      while (b <= last && !isP(toks[b], '{') && !isP(toks[b], ';')) b = isOpen(toks[b]) ? close(b) + 1 : b + 1;
      const end = isP(toks[b], '{') ? close(b) : Math.min(b, last);
      const name = nameTok ? nameTok.v : isDefault ? 'default' : null;
      if (name) addSymbol(name, 'function', exported, i, end);
      return end + 1;
    }
    if (isId(d, 'class') || isId(d, 'interface') || isId(d, 'enum')) {
      const next = toks[j + 1];
      const nameTok = isId(next) && !isId(next, 'extends') && !isId(next, 'implements') ? next : undefined;
      let b = j + 1;
      while (b <= last && !isP(toks[b], '{')) b = isOpen(toks[b]) ? close(b) + 1 : b + 1;
      const end = b <= last ? close(b) : last;
      const name = nameTok?.v ?? (isDefault ? 'default' : undefined);
      if (name) {
        addSymbol(name, d.v === 'class' ? 'class' : 'type', exported, i, end);
        if (d.v === 'class' && b <= last) addMethods(name, b, exported);
      }
      return end + 1;
    }
    if (isId(d, 'type') && isId(toks[j + 1]) && (isP(toks[j + 2], '=') || isP(toks[j + 2], '<'))) {
      const end = statementEnd(j);
      addSymbol(toks[j + 1].v, 'type', exported, i, end);
      return end + 1;
    }
    if (isId(d, 'const') || isId(d, 'let') || isId(d, 'var')) {
      const end = statementEnd(j);
      const nameTok = toks[j + 1];
      if (isId(nameTok)) {
        const spec = requireSpecifier(j + 2);
        if (spec !== null) imports.push({ specifier: spec, bindings: [{ local: nameTok.v, imported: '*' }], reexport: false });
        else addSymbol(nameTok.v, isFunctionInit(j + 2) ? 'function' : 'variable', exported, i, end);
      } else if (isP(nameTok, '{')) {
        const spec = requireSpecifier(close(j + 1) + 1);
        if (spec !== null) imports.push({ specifier: spec, bindings: readBraceBindings(j + 1, ':'), reexport: false });
      }
      return end + 1;
    }
    if (isDefault) {
      const end = statementEnd(j);
      if (isId(d) && end <= j + 1) exportedNames.add(d.v);
      else addSymbol('default', 'variable', true, i, end);
      return end + 1;
    }
    return isOpen(tk) ? close(i) + 1 : i + 1;
  };

  let at = 0;
  while (at <= last) at = Math.max(parseTopLevel(at), at + 1);

  toks.forEach((tk, k) => {
    if (!(isId(tk, 'require') || isId(tk, 'import')) || isP(toks[k - 1], '.')) return;
    if (!isP(toks[k + 1], '(') || toks[k + 2]?.t !== 'str') return;
    if (!isP(toks[k + 3], ')') && !isP(toks[k + 3], ',')) return;
    const specifier = toks[k + 2].v;
    if (!imports.some(im => im.specifier === specifier)) imports.push({ specifier, bindings: [], reexport: false });
  });

  for (const s of symbols) if (exportedNames.has(s.name)) s.exported = true;
  return { symbols, imports };
}
```

- [ ] **Step 4: Build, run, and iterate until green**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-guardian-graph-extract.test.js
```

Expected: all 7 tests `PASS`, `0 failed`. If one fails, fix `graph-extract.ts` (the test is the contract; do not weaken it).

- [ ] **Step 5: Commit**

```bash
git add mcp/servers/egc-guardian/src/graph-extract.ts tests/egc-guardian-graph-extract.test.js
git commit -m "feat(guardian): add a lexical JS/TS symbol and import extractor"
```

---

### Task 2: Graph store

**Files:**
- Create: `mcp/servers/egc-guardian/src/graph-store.ts`
- Test: `tests/egc-guardian-graph-store.test.js`

**Interfaces:**
- Consumes: `ExtractResult`, `ImportBinding` from `./graph-extract.js`; `openCompatDatabase(filename, serverName)` from `./sqlite-compat.js`.
- Produces:
  - `GRAPH_SCHEMA_VERSION: number`
  - `graphDbPath(projectRoot: string, env?: NodeJS.ProcessEnv): string`
  - `interface FileRow { path: string; mtimeMs: number; size: number; hash: string }`
  - `interface SymbolRow { id: number; file: string; name: string; kind: string; exported: boolean; startLine: number; endLine: number; refs: string[] }`
  - `interface ImportRow { file: string; specifier: string; bindings: ImportBinding[]; reexport: boolean }`
  - `interface EdgeRow { src: string; dst: string; kind: 'import' | 'ref' }` (node ids: `f:<path>`, `s:<symbolId>`)
  - `interface GraphData { files: FileRow[]; symbols: SymbolRow[]; imports: ImportRow[]; edges: EdgeRow[] }`
  - `interface GraphStore { getFiles(): Promise<Map<string, FileRow>>; replaceFile(file: FileRow, extracted: ExtractResult): Promise<void>; touchFile(file: FileRow): Promise<void>; removeFiles(paths: string[]): Promise<void>; replaceEdges(edges: EdgeRow[]): Promise<void>; load(): Promise<GraphData>; close(): Promise<void> }`
  - `openGraphStore(dbPath: string): Promise<GraphStore>`
  - `openGraphStoreWithRecovery(dbPath: string): Promise<GraphStore>` (on open failure deletes the db files once and retries)

- [ ] **Step 1: Write the failing test**

Create `tests/egc-guardian-graph-store.test.js`:

```js
'use strict';
/**
 * The graph store keeps files, symbols, imports and edges in SQLite, one
 * database per project, and rebuilds itself when the schema or file is bad.
 *
 * Run with: node tests/egc-guardian-graph-store.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'graph-store.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { graphDbPath, openGraphStore, openGraphStoreWithRecovery, GRAPH_SCHEMA_VERSION } = require(path.join(buildDir, 'graph-store.js'));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-graph-store-'));
const extracted = {
  symbols: [{ name: 'foo', kind: 'function', exported: true, startLine: 1, endLine: 3, refs: ['bar', 'ns.x'] }],
  imports: [{ specifier: './b.js', bindings: [{ local: 'bar', imported: 'bar' }], reexport: false }]
};

(async () => {
  await run('graphDbPath is stable per project, differs between projects, honors EGC_DIR', () => {
    const env = { EGC_DIR: tmp };
    const a = graphDbPath('/work/alpha', env);
    assert.strictEqual(a, graphDbPath('/work/alpha', env));
    assert.notStrictEqual(a, graphDbPath('/work/beta', env));
    assert.ok(a.startsWith(path.join(tmp, 'egc', 'graph')), a);
    assert.ok(a.endsWith('.db'));
    assert.ok(path.basename(a).startsWith('alpha-'));
  });

  await run('round trip: replaceFile, load, touchFile, removeFiles', async () => {
    const store = await openGraphStore(path.join(tmp, 'rt', 'g.db'));
    await store.replaceFile({ path: 'a.js', mtimeMs: 1, size: 10, hash: 'h1' }, extracted);
    const data = await store.load();
    assert.deepStrictEqual(data.files, [{ path: 'a.js', mtimeMs: 1, size: 10, hash: 'h1' }]);
    assert.strictEqual(data.symbols.length, 1);
    assert.deepStrictEqual(
      { ...data.symbols[0], id: 0 },
      { id: 0, file: 'a.js', name: 'foo', kind: 'function', exported: true, startLine: 1, endLine: 3, refs: ['bar', 'ns.x'] }
    );
    assert.deepStrictEqual(data.imports, [{ file: 'a.js', specifier: './b.js', bindings: [{ local: 'bar', imported: 'bar' }], reexport: false }]);

    await store.touchFile({ path: 'a.js', mtimeMs: 2, size: 10, hash: 'h1' });
    assert.strictEqual((await store.getFiles()).get('a.js').mtimeMs, 2);
    assert.strictEqual((await store.load()).symbols.length, 1, 'touch keeps symbols');

    await store.replaceFile({ path: 'a.js', mtimeMs: 3, size: 11, hash: 'h2' }, { symbols: [], imports: [] });
    assert.strictEqual((await store.load()).symbols.length, 0, 'replace drops the old rows');

    await store.replaceEdges([{ src: 'f:a.js', dst: 'f:b.js', kind: 'import' }]);
    assert.strictEqual((await store.load()).edges.length, 1);
    await store.replaceEdges([]);
    assert.strictEqual((await store.load()).edges.length, 0);

    await store.removeFiles(['a.js']);
    assert.strictEqual((await store.getFiles()).size, 0);
    await store.close();
  });

  await run('a database with another schema version is rebuilt empty', async () => {
    const p = path.join(tmp, 'ver', 'g.db');
    const store = await openGraphStore(p);
    await store.replaceFile({ path: 'a.js', mtimeMs: 1, size: 1, hash: 'h' }, extracted);
    await store.close();

    const { openCompatDatabase } = require(path.join(buildDir, 'sqlite-compat.js'));
    const db = await openCompatDatabase(p, 'egc-guardian');
    await db.run("UPDATE meta SET value = ? WHERE key = 'version'", String(GRAPH_SCHEMA_VERSION + 1));
    await db.close();

    const again = await openGraphStore(p);
    assert.strictEqual((await again.getFiles()).size, 0);
    await again.close();
  });

  await run('a corrupt database file is replaced by openGraphStoreWithRecovery', async () => {
    const p = path.join(tmp, 'bad', 'g.db');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'this is not a sqlite file at all, just text'.repeat(50));
    const store = await openGraphStoreWithRecovery(p);
    await store.replaceFile({ path: 'a.js', mtimeMs: 1, size: 1, hash: 'h' }, extracted);
    assert.strictEqual((await store.getFiles()).size, 1);
    await store.close();
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/egc-guardian-graph-store.test.js`
Expected: `[SKIP]` (no `graph-store.js` in build yet) or `Cannot find module`. Not green.

- [ ] **Step 3: Write the implementation**

Create `mcp/servers/egc-guardian/src/graph-store.ts`:

```ts
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
```

- [ ] **Step 4: Build, run, iterate until green**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-guardian-graph-store.test.js
```

Expected: 4 `PASS`, `0 failed`. Note: the build directory contains `sqlite-compat.js` (the version-mismatch test requires it).

- [ ] **Step 5: Commit**

```bash
git add mcp/servers/egc-guardian/src/graph-store.ts tests/egc-guardian-graph-store.test.js
git commit -m "feat(guardian): add the SQLite graph store with schema versioning and recovery"
```

---

### Task 3: Graph build (walk, ignore, resolve, edges, lock)

**Files:**
- Create: `mcp/servers/egc-guardian/src/graph-build.ts`
- Test: `tests/egc-guardian-graph-build.test.js`

**Interfaces:**
- Consumes: `extractFile` (Task 1); `GraphStore`, `GraphData`, `EdgeRow`, `SymbolRow`, `FileRow` (Task 2).
- Produces:
  - `makeIgnore(gitignoreText: string): (rel: string, isDir: boolean) => boolean`
  - `resolveSpecifier(fromFile: string, specifier: string, fileSet: Set<string>): string | null`
  - `computeEdges(data: Pick<GraphData, 'files' | 'symbols' | 'imports'>): EdgeRow[]`
  - `interface BuildOptions { maxFiles?: number; maxMs?: number; maxFileBytes?: number; isProtectedPath?: (absPath: string) => boolean }`
  - `interface BuildResult { status: 'ok' | 'partial'; files: number; refreshed: number; removed: number; buildMs: number }`
  - `buildGraph(projectRoot: string, store: GraphStore, opts?: BuildOptions): Promise<BuildResult>`
  - `withBuildLock<T>(dbPath: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>`

- [ ] **Step 1: Write the failing test**

Create `tests/egc-guardian-graph-build.test.js`:

```js
'use strict';
/**
 * The graph builder walks a project, indexes only changed files on a later
 * run, resolves relative imports, links symbols to the symbols they use, and
 * never reads outside the project or the files it must not index.
 *
 * Run with: node tests/egc-guardian-graph-build.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'graph-build.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { buildGraph, makeIgnore, resolveSpecifier, withBuildLock } = require(path.join(buildDir, 'graph-build.js'));
const { openGraphStore } = require(path.join(buildDir, 'graph-store.js'));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-graph-build-'));
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
const open = () => openGraphStore(path.join(tmp, `db${n++}`, 'g.db'));
const bump = file => {
  const t = new Date(Date.now() + 5000 * ++n);
  fs.utimesSync(file, t, t);
};

(async () => {
  await run('makeIgnore: names, rooted paths, directories, globs, comments', () => {
    const ig = makeIgnore('# c\nlogs/\n/rooted.js\n*.gen.js\nsrc/skip\n');
    assert.ok(ig('logs', true));
    assert.ok(ig('a/logs', true));
    assert.ok(!ig('logs', false), 'a trailing slash matches directories only');
    assert.ok(ig('rooted.js', false));
    assert.ok(!ig('sub/rooted.js', false));
    assert.ok(ig('x/y/z.gen.js', false));
    assert.ok(ig('src/skip/a.js', false));
    assert.ok(!ig('lib/src/skip', false), 'a rule with a slash is anchored at the root');
    assert.ok(!ig('src/keep.js', false));
  });

  await run('resolveSpecifier: extension probing, index files, ts swap, bare and escaping specifiers', () => {
    const set = new Set(['lib/a.ts', 'lib/dir/index.js', 'top.js', 'b.js']);
    assert.strictEqual(resolveSpecifier('lib/x.ts', './a.js', set), 'lib/a.ts');
    assert.strictEqual(resolveSpecifier('lib/x.ts', './a', set), 'lib/a.ts');
    assert.strictEqual(resolveSpecifier('lib/x.ts', './dir', set), 'lib/dir/index.js');
    assert.strictEqual(resolveSpecifier('lib/x.ts', '../top.js', set), 'top.js');
    assert.strictEqual(resolveSpecifier('a.js', './b', set), 'b.js');
    assert.strictEqual(resolveSpecifier('lib/x.ts', 'lodash', set), null);
    assert.strictEqual(resolveSpecifier('x.js', '../../etc/passwd', set), null);
    assert.strictEqual(resolveSpecifier('x.js', './missing', set), null);
  });

  await run('first build indexes sources, honors ignores and links symbols', async () => {
    const root = project({
      'a.js': "import { b } from './b.js';\nexport function a() { return b(); }\n",
      'b.js': 'export function b() { return 1; }\n',
      'node_modules/x/i.js': 'export const nm = 1;\n',
      'dist/o.js': 'export const out = 1;\n',
      'ignored/z.js': 'export const z = 1;\n',
      '.gitignore': 'ignored/\n',
      'readme.md': '# not source\n'
    });
    const store = await open();
    const res = await buildGraph(root, store);
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(res.files, 2);
    assert.strictEqual(res.refreshed, 2);
    const data = await store.load();
    assert.deepStrictEqual(data.files.map(f => f.path), ['a.js', 'b.js']);
    assert.ok(data.edges.some(e => e.kind === 'import' && e.src === 'f:a.js' && e.dst === 'f:b.js'));
    const a = data.symbols.find(s => s.name === 'a');
    const b = data.symbols.find(s => s.name === 'b');
    assert.ok(data.edges.some(e => e.kind === 'ref' && e.src === `s:${a.id}` && e.dst === `s:${b.id}`), JSON.stringify(data.edges));
    await store.close();
  });

  await run('a second build refreshes nothing; a change refreshes one file and re-links', async () => {
    const root = project({
      'a.js': "import { b } from './b.js';\nexport function a() { return b(); }\n",
      'b.js': 'export function b() { return 1; }\n'
    });
    const store = await open();
    await buildGraph(root, store);
    assert.strictEqual((await buildGraph(root, store)).refreshed, 0);

    fs.appendFileSync(path.join(root, 'b.js'), 'export function c() { return b(); }\n');
    bump(path.join(root, 'b.js'));
    const res = await buildGraph(root, store);
    assert.strictEqual(res.refreshed, 1);
    const data = await store.load();
    const a = data.symbols.find(s => s.name === 'a');
    const b = data.symbols.find(s => s.name === 'b');
    assert.ok(data.edges.some(e => e.kind === 'ref' && e.src === `s:${a.id}` && e.dst === `s:${b.id}`), 'a edge into a re-extracted file is rebuilt');
    await store.close();
  });

  await run('a touched file with identical content is not re-extracted', async () => {
    const root = project({ 'a.js': 'export const a = 1;\n' });
    const store = await open();
    await buildGraph(root, store);
    bump(path.join(root, 'a.js'));
    assert.strictEqual((await buildGraph(root, store)).refreshed, 0);
    await store.close();
  });

  await run('deleting a file removes its rows and edges', async () => {
    const root = project({
      'a.js': "import { b } from './b.js';\nexport function a() { return b(); }\n",
      'b.js': 'export function b() { return 1; }\n'
    });
    const store = await open();
    await buildGraph(root, store);
    fs.rmSync(path.join(root, 'b.js'));
    const res = await buildGraph(root, store);
    assert.strictEqual(res.removed, 1);
    const data = await store.load();
    assert.deepStrictEqual(data.files.map(f => f.path), ['a.js']);
    assert.strictEqual(data.edges.length, 0);
    await store.close();
  });

  await run('caps: maxFiles gives a partial graph, oversize and protected files are skipped', async () => {
    const root = project({ 'a.js': 'export const a = 1;\n', 'b.js': 'export const b = 1;\n', 'big.js': 'export const big = "' + 'x'.repeat(500) + '";\n', 'secret.js': 'export const s = 1;\n' });
    const s1 = await open();
    const partial = await buildGraph(root, s1, { maxFiles: 2 });
    assert.strictEqual(partial.status, 'partial');
    assert.ok(partial.files <= 2);
    await s1.close();

    const s2 = await open();
    const res = await buildGraph(root, s2, { maxFileBytes: 100, isProtectedPath: p => path.basename(p) === 'secret.js' });
    assert.deepStrictEqual((await s2.load()).files.map(f => f.path), ['a.js', 'b.js']);
    assert.strictEqual(res.status, 'ok');
    await s2.close();
  });

  await run('symlinks are never followed', async () => {
    const outside = project({ 'leak.js': 'export const leak = 1;\n' });
    const root = project({ 'a.js': 'export const a = 1;\n' });
    try {
      fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
      fs.symlinkSync(path.join(outside, 'leak.js'), path.join(root, 'leak-link.js'), 'file');
    } catch {
      console.log('    (symlinks not permitted here, partial check only)');
    }
    const store = await open();
    await buildGraph(root, store);
    assert.deepStrictEqual((await store.load()).files.map(f => f.path), ['a.js']);
    await store.close();
  });

  await run('a file that is not valid source does not stop the build', async () => {
    const root = project({ 'junk.js': '}}}} export function (( {{ `', 'ok.js': 'export const ok = 1;\n' });
    const store = await open();
    const res = await buildGraph(root, store);
    assert.strictEqual(res.status, 'ok');
    assert.ok((await store.load()).symbols.some(s => s.name === 'ok'));
    await store.close();
  });

  await run('withBuildLock: a second caller is refused while the first runs', async () => {
    const db = path.join(tmp, 'lock', 'g.db');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    let inner;
    const outer = await withBuildLock(db, async () => {
      inner = await withBuildLock(db, async () => 'never');
      return 'outer';
    });
    assert.deepStrictEqual(inner, { ran: false });
    assert.deepStrictEqual(outer, { ran: true, value: 'outer' });
    const again = await withBuildLock(db, async () => 'again');
    assert.deepStrictEqual(again, { ran: true, value: 'again' }, 'the lock is released');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/egc-guardian-graph-build.test.js`
Expected: `[SKIP]` or `Cannot find module .../graph-build.js`. Not green.

- [ ] **Step 3: Write the implementation**

Create `mcp/servers/egc-guardian/src/graph-build.ts`:

```ts
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
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
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

async function walk(root: string, ignore: IgnoreFn, maxFiles: number, deadline: number): Promise<{ files: string[]; truncated: boolean }> {
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
      } else if (e.isFile() && SOURCE_EXT.test(e.name) && !ignore(childRel, false)) {
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

  const walked = await walk(root, ignore, maxFiles, deadline);
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

export async function withBuildLock<T>(dbPath: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const lock = `${dbPath}.lock`;
  const acquire = (): number | null => {
    try {
      return fs.openSync(lock, 'wx');
    } catch {
      return null;
    }
  };
  let fd = acquire();
  if (fd === null) {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) {
        fs.unlinkSync(lock);
        fd = acquire();
      }
    } catch {
      // another process took or removed it first
    }
  }
  if (fd === null) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lock); } catch { /* already removed */ }
  }
}
```

- [ ] **Step 4: Build, run, iterate until green**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-guardian-graph-build.test.js
```

Expected: 10 `PASS`, `0 failed`. If the ignore-rule test fails on a specific assertion, fix `compileRule` rather than the assertion (the cases are gitignore semantics).

- [ ] **Step 5: Commit**

```bash
git add mcp/servers/egc-guardian/src/graph-build.ts tests/egc-guardian-graph-build.test.js
git commit -m "feat(guardian): build the code graph incrementally with import resolution and edges"
```

---

### Task 4: Graph query (ranking and snippets)

**Files:**
- Create: `mcp/servers/egc-guardian/src/graph-query.ts`
- Test: `tests/egc-guardian-graph-query.test.js`

**Interfaces:**
- Consumes: `GraphData`, `SymbolRow` (Task 2).
- Produces:
  - `splitWords(text: string): string[]`
  - `interface Snippet { symbol: string; startLine: number; endLine: number; text: string; truncated?: boolean }`
  - `interface ContextFile { path: string; score: number; why: string[]; snippets: Snippet[] }`
  - `interface RelevantContext { files: ContextFile[]; tokensEstimated: number; truncated: boolean; dropped: number }`
  - `interface QueryOptions { budgetTokens?: number; seeds?: number; hops?: number; readFile: (relPath: string) => Promise<string | null>; transformSnippet?: (text: string) => string | null }`
  - `queryGraph(prompt: string, graph: GraphData, opts: QueryOptions): Promise<RelevantContext>`

- [ ] **Step 1: Write the failing test**

Create `tests/egc-guardian-graph-query.test.js`:

```js
'use strict';
/**
 * The graph query turns a task prompt into a short, ranked, budgeted list of
 * code snippets, with the reason each one is there.
 *
 * Run with: node tests/egc-guardian-graph-query.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'graph-query.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { queryGraph, splitWords } = require(buildPath);

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

const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
const SOURCES = {
  'validator.js': ['export function validateCommand(cmd) {', '  return cmd;', '}', '', 'export function isProtectedPath(p) {', '  return p;', '}'].join('\n'),
  'index.js': ['function handleTask(x) {', '  return validateCommand(x);', '}'].join('\n'),
  'util.js': ['export function formatDate(d) {', '  return d;', '}'].join('\n')
};
const readFile = async rel => SOURCES[rel] ?? null;
const sym = (id, file, name, startLine, endLine, extra = {}) => ({ id, file, name, kind: 'function', exported: true, startLine, endLine, refs: [], ...extra });
const GRAPH = {
  files: Object.keys(SOURCES).map(p => ({ path: p, mtimeMs: 1, size: 1, hash: 'h' })),
  symbols: [
    sym(1, 'validator.js', 'validateCommand', 1, 3),
    sym(2, 'validator.js', 'isProtectedPath', 5, 7),
    sym(3, 'index.js', 'handleTask', 1, 3, { exported: false }),
    sym(4, 'util.js', 'formatDate', 1, 3)
  ],
  imports: [],
  edges: [{ src: 's:3', dst: 's:1', kind: 'ref' }]
};

(async () => {
  await run('splitWords splits camelCase and snake_case and drops stopwords and short words', () => {
    assert.deepStrictEqual(splitWords('Fix the validateCommand bug in my_helper_fn'), ['fix', 'validate', 'command', 'bug', 'helper']);
  });

  await run('a named symbol ranks first and explains itself', async () => {
    const r = await queryGraph('fix validateCommand to reject empty input', GRAPH, { readFile });
    assert.strictEqual(r.files[0].path, 'validator.js');
    assert.strictEqual(r.files[0].snippets[0].symbol, 'validateCommand');
    assert.ok(r.files[0].snippets[0].text.includes('export function validateCommand'));
    assert.ok(r.files[0].why[0].startsWith('matched "'), r.files[0].why[0]);
  });

  await run('related code is pulled in by edges, with the direction in the reason; unrelated code is not', async () => {
    const r = await queryGraph('fix validateCommand', GRAPH, { readFile });
    const index = r.files.find(f => f.path === 'index.js');
    assert.ok(index, 'the caller is included');
    assert.deepStrictEqual(index.why, ['calls validateCommand']);
    assert.ok(!r.files.some(f => f.path === 'util.js'));
  });

  await run('hops bound the expansion and each hop decays the score', async () => {
    const chain = {
      files: [{ path: 'c.js', mtimeMs: 1, size: 1, hash: 'h' }],
      symbols: ['alphaStep', 'betaStep', 'gammaStep'].map((n, i) => sym(i + 1, 'c.js', n, i * 2 + 1, i * 2 + 2)),
      imports: [],
      edges: [{ src: 's:1', dst: 's:2', kind: 'ref' }, { src: 's:2', dst: 's:3', kind: 'ref' }]
    };
    const src = { 'c.js': 'a1\na2\nb1\nb2\ng1\ng2' };
    const rf = async rel => src[rel] ?? null;
    const two = await queryGraph('alphaStep', chain, { readFile: rf, hops: 2 });
    const order = two.files[0].snippets.map(s => s.symbol);
    assert.deepStrictEqual(order, ['alphaStep', 'betaStep', 'gammaStep'], 'snippets of one file are in line order');
    const one = await queryGraph('alphaStep', chain, { readFile: rf, hops: 1 });
    assert.deepStrictEqual(one.files[0].snippets.map(s => s.symbol), ['alphaStep', 'betaStep']);
  });

  await run('rare words outweigh common ones (idf)', async () => {
    const syms = [sym(1, 'a.js', 'parseIndex', 1, 1), sym(2, 'a.js', 'validateCommand', 2, 2)];
    for (let i = 0; i < 6; i++) syms.push(sym(10 + i, 'a.js', `index${'ABCDEF'[i]}`, 3 + i, 3 + i));
    const g = { files: [{ path: 'a.js', mtimeMs: 1, size: 1, hash: 'h' }], symbols: syms, imports: [], edges: [] };
    const rf = async () => Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n');
    const r = await queryGraph('index validate command', g, { readFile: rf, seeds: 1, hops: 0 });
    assert.strictEqual(r.files[0].snippets[0].symbol, 'validateCommand');
  });

  await run('the token budget is a hard cap and reports truncation', async () => {
    const r = await queryGraph('validateCommand isProtectedPath handleTask', GRAPH, { readFile, budgetTokens: 25 });
    assert.ok(r.tokensEstimated <= 25, String(r.tokensEstimated));
    assert.strictEqual(r.truncated, true);
  });

  await run('a symbol bigger than 40% of the budget is cut and marked', async () => {
    const big = { files: [{ path: 'big.js', mtimeMs: 1, size: 1, hash: 'h' }], symbols: [sym(1, 'big.js', 'hugeFunction', 1, 200)], imports: [], edges: [] };
    const rf = async () => lines(200);
    const r = await queryGraph('hugeFunction', big, { readFile: rf, budgetTokens: 400 });
    const s = r.files[0].snippets[0];
    assert.strictEqual(s.truncated, true);
    assert.ok(s.text.length <= 400 * 4 * 0.4 + 20, String(s.text.length));
  });

  await run('transformSnippet can redact or drop a snippet', async () => {
    const r = await queryGraph('validateCommand', GRAPH, {
      readFile,
      transformSnippet: t => (t.includes('handleTask') ? null : t.replace('return cmd;', 'return [redacted];'))
    });
    assert.ok(r.files[0].snippets[0].text.includes('[redacted]'));
    assert.ok(!r.files.some(f => f.path === 'index.js'));
    assert.strictEqual(r.dropped, 1);
  });

  await run('no usable words or no match gives an empty result, never an error', async () => {
    for (const p of ['', '   ', 'the and for', '!!! ???', 'zzzqqq']) {
      const r = await queryGraph(p, GRAPH, { readFile });
      assert.deepStrictEqual(r.files, []);
      assert.strictEqual(r.tokensEstimated, 0);
    }
  });

  await run('ties are broken by path then line, so output is stable', async () => {
    const g = {
      files: [{ path: 'b.js', mtimeMs: 1, size: 1, hash: 'h' }, { path: 'a.js', mtimeMs: 1, size: 1, hash: 'h' }],
      symbols: [sym(1, 'b.js', 'sameName', 1, 1), sym(2, 'a.js', 'sameName', 1, 1)],
      imports: [],
      edges: []
    };
    const rf = async () => 'x';
    const r = await queryGraph('sameName', g, { readFile: rf });
    assert.deepStrictEqual(r.files.map(f => f.path), ['a.js', 'b.js']);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/egc-guardian-graph-query.test.js`
Expected: `[SKIP]` or `Cannot find module .../graph-query.js`.

- [ ] **Step 3: Write the implementation**

Create `mcp/servers/egc-guardian/src/graph-query.ts`:

```ts
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

export function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STOP.has(w));
}

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
const lastSegment = (name: string): string => name.slice(name.lastIndexOf('.') + 1);

interface Reach { score: number; why: string }

export async function queryGraph(prompt: string, graph: GraphData, opts: QueryOptions): Promise<RelevantContext> {
  const budget = opts.budgetTokens ?? 2000;
  const seedCount = opts.seeds ?? 8;
  const hops = opts.hops ?? 2;
  const empty: RelevantContext = { files: [], tokensEstimated: 0, truncated: false, dropped: 0 };

  const promptWords = new Set(splitWords(prompt));
  if (promptWords.size === 0) return empty;
  const promptIdents = new Set((prompt.match(/[A-Za-z_$][\w$]*/g) ?? []).map(w => w.toLowerCase()));

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

  const byId = new Map<number, SymbolRow>(graph.symbols.map(s => [s.id, s]));
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
  const byRank = (a: { s: SymbolRow; score: number }, b: { s: SymbolRow; score: number }): number =>
    b.score - a.score || (a.s.file < b.s.file ? -1 : a.s.file > b.s.file ? 1 : 0) || a.s.startLine - b.s.startLine;
  seeds.sort(byRank);
  const topSeeds = seeds.slice(0, seedCount);
  if (topSeeds.length === 0) return empty;

  const adjacency = new Map<string, Array<{ to: string; kind: 'import' | 'ref'; forward: boolean }>>();
  const link = (from: string, to: string, kind: 'import' | 'ref', forward: boolean): void => {
    const list = adjacency.get(from);
    const entry = { to, kind, forward };
    if (list) list.push(entry);
    else adjacency.set(from, [entry]);
  };
  for (const e of graph.edges) {
    link(e.src, e.dst, e.kind, true);
    link(e.dst, e.src, e.kind, false);
  }
  const label = (id: string): string => (id.startsWith('s:') ? byId.get(Number(id.slice(2)))?.name ?? id : id.slice(2));

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
        let why: string;
        if (edge.kind === 'import') why = edge.forward ? `imported by ${label(id)}` : `imports ${label(id)}`;
        else why = edge.forward ? `called by ${label(id)}` : `calls ${label(id)}`;
        best.set(edge.to, { score, why });
        next.push(edge.to);
      }
    }
    frontier = next;
  }

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

  const ranked = [...candidates.entries()]
    .map(([symbolId, reach]) => ({ s: byId.get(symbolId) as SymbolRow, ...reach }))
    .filter(c => c.s)
    .sort((a, b) => b.score - a.score || (a.s.file < b.s.file ? -1 : a.s.file > b.s.file ? 1 : 0) || a.s.startLine - b.s.startLine);

  const fileLines = new Map<string, string[] | null>();
  const taken = new Map<string, Array<[number, number]>>();
  const perFile = new Map<string, { score: number; why: Set<string>; snippets: Snippet[] }>();
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

    let snippetLines = all.slice(c.s.startLine - 1, c.s.endLine);
    let cut = false;
    while (snippetLines.length > 1 && estimateTokens(snippetLines.join('\n')) > maxOne) {
      snippetLines = snippetLines.slice(0, Math.max(1, Math.floor(snippetLines.length * 0.8)));
      cut = true;
    }
    let text = snippetLines.join('\n');
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
    ranges.push([c.s.startLine, c.s.endLine]);
    taken.set(c.s.file, ranges);
    const entry = perFile.get(c.s.file) ?? { score: c.score, why: new Set<string>(), snippets: [] };
    entry.score = Math.max(entry.score, c.score);
    entry.why.add(c.why);
    entry.snippets.push({ symbol: c.s.name, startLine: c.s.startLine, endLine: c.s.startLine + snippetLines.length - 1, text, ...(cut ? { truncated: true } : {}) });
    perFile.set(c.s.file, entry);
    if (cut) truncated = true;
  }

  const files: ContextFile[] = [...perFile.entries()]
    .map(([p, e]) => ({ path: p, score: Math.round(e.score * 100) / 100, why: [...e.why].slice(0, 3), snippets: e.snippets.sort((a, b) => a.startLine - b.startLine) }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, tokensEstimated: used, truncated, dropped };
}
```

- [ ] **Step 4: Build, run, iterate until green**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-guardian-graph-query.test.js
```

Expected: 10 `PASS`, `0 failed`. If the `splitWords` expectation differs, check that `Fix` stays (length 3, not a stopword) and `my_helper_fn` yields `helper` only (`my` and `fn` are shorter than 3).

- [ ] **Step 5: Commit**

```bash
git add mcp/servers/egc-guardian/src/graph-query.ts tests/egc-guardian-graph-query.test.js
git commit -m "feat(guardian): rank graph nodes for a prompt and cut budgeted snippets"
```

---

### Task 5: Context wrapper and `orchestrate_task` wiring

**Files:**
- Create: `mcp/servers/egc-guardian/src/graph-context.ts`
- Modify: `mcp/servers/egc-guardian/src/index.ts` (imports near line 27; `OrchestrateTaskSchema` at line 220; the `orchestrate_task` tool entry at lines 266-277; `handleOrchestrateTask` at line 476)
- Test: `tests/egc-guardian-graph-context.test.js`

**Interfaces:**
- Consumes: `graphDbPath`, `openGraphStoreWithRecovery` (Task 2); `buildGraph`, `withBuildLock` (Task 3); `queryGraph` (Task 4).
- Produces:
  - `interface ContextDeps { env?: NodeJS.ProcessEnv; isProtectedPath?: (absPath: string) => boolean; transformSnippet?: (text: string) => string | null; audit?: (action: string, details: Record<string, unknown>) => void }`
  - `buildRelevantContext(prompt: string, projectPath: string | undefined, budgetTokens: number | undefined, deps?: ContextDeps): Promise<Record<string, unknown>>` returning either `{ status: 'ok' | 'partial', files: [...], tokens_estimated, truncated, dropped, graph: { files, refreshed, build_ms, build: 'ran' | 'busy' } }` or `{ status: 'unavailable', reason: string }`. File entries use `snake_case` keys: `path, score, why, snippets: [{ symbol, start_line, end_line, text, truncated? }]`.

- [ ] **Step 1: Write the failing test**

Create `tests/egc-guardian-graph-context.test.js`:

```js
'use strict';
/**
 * buildRelevantContext is what orchestrate_task calls: it owns the safety
 * checks, the lock, the audit events, and turning every failure into an
 * "unavailable" answer instead of an error.
 *
 * Run with: node tests/egc-guardian-graph-context.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'graph-context.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { buildRelevantContext } = require(path.join(buildDir, 'graph-context.js'));
const { graphDbPath } = require(path.join(buildDir, 'graph-store.js'));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-graph-context-'));
const env = { ...process.env, EGC_DIR: path.join(tmp, 'egc-home') };
const root = path.join(tmp, 'proj');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'helper.js'), 'export function parseHelper(input) {\n  return String(input).trim();\n}\n');
fs.writeFileSync(path.join(root, 'main.js'), "import { parseHelper } from './helper.js';\nexport function runMain(x) {\n  return parseHelper(x);\n}\n");
fs.writeFileSync(path.join(root, 'secrets.js'), 'export const apiKey = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";\nexport function useKey() { return apiKey; }\n');

(async () => {
  await run('returns ranked snippets with graph stats, then refreshes nothing on the second call', async () => {
    const audits = [];
    const deps = { env, audit: (action, details) => audits.push({ action, details }) };
    const first = await buildRelevantContext('change parseHelper to also lowercase', root, undefined, deps);
    assert.strictEqual(first.status, 'ok', JSON.stringify(first));
    assert.strictEqual(first.files[0].path, 'helper.js');
    assert.strictEqual(first.files[0].snippets[0].symbol, 'parseHelper');
    assert.ok('start_line' in first.files[0].snippets[0]);
    assert.ok(first.files.some(f => f.path === 'main.js'), 'the caller comes along');
    assert.strictEqual(first.graph.refreshed, 3);
    assert.strictEqual(first.graph.build, 'ran');

    const second = await buildRelevantContext('change parseHelper', root, undefined, deps);
    assert.strictEqual(second.graph.refreshed, 0);
    const events = audits.map(a => a.action);
    assert.ok(events.includes('GRAPH_QUERY'));
    assert.ok(!JSON.stringify(audits).includes('trim()'), 'audit events carry no snippet text');
  });

  await run('transformSnippet is applied to everything returned', async () => {
    const r = await buildRelevantContext('parseHelper', root, undefined, { env, transformSnippet: t => t.replace(/trim\(\)/g, 'HIDDEN') });
    assert.ok(JSON.stringify(r).includes('HIDDEN'));
    assert.ok(!JSON.stringify(r).includes('trim()'));
  });

  await run('a protected path callback keeps a file out of the graph', async () => {
    const r = await buildRelevantContext('useKey apiKey', root, undefined, { env, isProtectedPath: p => path.basename(p) === 'secrets.js' });
    assert.ok(!JSON.stringify(r).includes('sk-ant'), 'the secret never appears');
  });

  await run('bad project paths are unavailable, not errors and not walked', async () => {
    for (const p of [path.join(tmp, 'missing'), path.join(root, 'main.js'), path.parse(root).root, os.homedir()]) {
      const r = await buildRelevantContext('anything useful', p, undefined, { env });
      assert.strictEqual(r.status, 'unavailable', p);
      assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
    }
  });

  await run('a prompt with no usable words is ok with no files', async () => {
    const r = await buildRelevantContext('???', root, undefined, { env });
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.files, []);
  });

  await run('a corrupt database is rebuilt once and the call still succeeds', async () => {
    const db = graphDbPath(fs.realpathSync(root), env);
    fs.writeFileSync(db, 'not sqlite '.repeat(200));
    const r = await buildRelevantContext('parseHelper', root, undefined, { env });
    assert.strictEqual(r.status, 'ok', JSON.stringify(r));
    assert.strictEqual(r.files[0].path, 'helper.js');
  });

  await run('two callers at once on a cold project both succeed', async () => {
    const cold = path.join(tmp, 'cold');
    fs.mkdirSync(cold);
    fs.writeFileSync(path.join(cold, 'a.js'), 'export function coldStart() { return 1; }\n');
    const [x, y] = await Promise.all([
      buildRelevantContext('coldStart', cold, undefined, { env }),
      buildRelevantContext('coldStart', cold, undefined, { env })
    ]);
    for (const r of [x, y]) assert.notStrictEqual(r.status, undefined);
    assert.ok([x, y].some(r => r.status === 'ok' && r.graph.build === 'ran'));
    for (const r of [x, y]) assert.ok(r.status === 'ok' || r.status === 'unavailable', JSON.stringify(r));
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/egc-guardian-graph-context.test.js`
Expected: `[SKIP]` or `Cannot find module .../graph-context.js`.

- [ ] **Step 3: Write `graph-context.ts`**

Create `mcp/servers/egc-guardian/src/graph-context.ts`:

```ts
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

function resolveRoot(projectPath: string | undefined): { root: string } | { reason: string } {
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(projectPath ?? process.cwd()));
    if (!fs.statSync(root).isDirectory()) return { reason: 'project path is not a directory' };
  } catch {
    return { reason: 'project path does not exist' };
  }
  if (path.parse(root).root === root) return { reason: 'refusing to index a filesystem root' };
  let home: string | null = null;
  try {
    home = fs.realpathSync(os.homedir());
  } catch {
    home = null;
  }
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
```

- [ ] **Step 4: Build, run, iterate until green**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
node tests/egc-guardian-graph-context.test.js
```

Expected: 7 `PASS`, `0 failed`. Note on the home-directory case: the test passes `os.homedir()`, which must be refused regardless of the machine.

- [ ] **Step 5: Wire it into `index.ts`**

In `mcp/servers/egc-guardian/src/index.ts`:

1. Add the import after the existing `import { compressViaHeadroom } from './headroom-client.js';` line (27):

```ts
import { buildRelevantContext } from './graph-context.js';
```

2. Replace `OrchestrateTaskSchema` (line 220) with:

```ts
const OrchestrateTaskSchema = z.object({
  prompt: z.string(),
  filepaths: z.array(z.string()).optional().default([]),
  heuristic_sandbox_id: z.string().optional(),
  project_path: z.string().optional(),
  context_budget_tokens: z.number().int().min(200).max(8000).optional()
});
```

3. In the `orchestrate_task` tool entry (lines 266-277), append a sentence to `description` and the two properties. Change the end of the description string from `...Also returns context-reduction metrics for any file payloads.` to `...Also returns context-reduction metrics for any file payloads, and a relevant_context block of ranked snippets from the project's own JS/TS code, found through a local graph of its files, symbols, imports and references.` and set:

```ts
          properties: {
             prompt: { type: "string" },
             filepaths: { type: "array", items: { type: "string" } },
             project_path: { type: "string", description: "Absolute path to the project root for relevant_context. Defaults to the server's working directory." },
             context_budget_tokens: { type: "number", description: "Token budget for relevant_context snippets (200-8000, default 2000)." }
          },
```

4. In `handleOrchestrateTask`, after `const hint = ...` (line 498) add:

```ts
  const relevantContext = await buildRelevantContext(prompt, parsed.project_path, parsed.context_budget_tokens, {
    isProtectedPath: p => isProtectedPath(p),
    transformSnippet: text => {
      if (scanForInjection(text).length > 0) return null;
      return String(redactPayload({ text }).text);
    },
    audit: (action, details) => auditLog(action, 'ALLOWED', details)
  });
```

and add `relevant_context: relevantContext,` to the returned object right after the `files_loaded: filesLoaded,` line.

- [ ] **Step 6: Build and run the whole graph suite plus the existing guardian tests**

Run:

```bash
npm --prefix mcp/servers/egc-guardian run build
for t in extract store build query context; do node tests/egc-guardian-graph-$t.test.js || exit 1; done
node tests/egc-guardian-symlink.test.js
```

Expected: all pass; the build has no TypeScript errors.

- [ ] **Step 7: Add a stdio smoke test of the real tool**

Append to `tests/egc-guardian-graph-context.test.js`, before the final `fs.rmSync(tmp...)` line, a test that starts `build/index.js`, calls `tools/call orchestrate_task` over JSON-RPC and checks the block:

```js
  await run('orchestrate_task over stdio returns relevant_context and keeps its other fields', async () => {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [path.join(buildDir, 'index.js')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = new Map();
    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        pending.get(msg.id)?.(msg);
      }
    });
    const rpc = (id, method, params) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 20000);
      pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    try {
      await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const res = await rpc(2, 'tools/call', { name: 'orchestrate_task', arguments: { prompt: 'change parseHelper', project_path: root } });
      const body = JSON.parse(res.result.content[0].text);
      assert.ok(body.routing && body.context_reduction, 'existing fields are intact');
      assert.strictEqual(body.relevant_context.status, 'ok', JSON.stringify(body.relevant_context));
      assert.strictEqual(body.relevant_context.files[0].path, 'helper.js');
    } finally {
      child.kill();
    }
  });
```

Run: `node tests/egc-guardian-graph-context.test.js`
Expected: 8 `PASS`. If the server prints non-JSON lines to stdout the parse fails; the guardian logs to stderr and files, so this should not occur.

- [ ] **Step 8: Commit**

```bash
git add mcp/servers/egc-guardian/src/graph-context.ts mcp/servers/egc-guardian/src/index.ts tests/egc-guardian-graph-context.test.js
git commit -m "feat(guardian): orchestrate_task returns relevant_context from the code graph"
```

---

### Task 6: Self-benchmark, docs and changelog

**Files:**
- Create: `tests/egc-guardian-graph-selfbench.test.js`
- Modify: `docs/token-optimization.md` (the Guardian paragraph at line 13), `CHANGELOG.md` (under `## [Unreleased]` / `### Added`)

**Interfaces:**
- Consumes: `buildRelevantContext` (Task 5).

- [ ] **Step 1: Write the benchmark test**

Create `tests/egc-guardian-graph-selfbench.test.js`. It indexes this repository's guardian sources and checks that each sample prompt surfaces the file a person would expect among the top results. It is a regression guard, not an accuracy claim:

```js
'use strict';
/**
 * Regression check on this repository: for sample prompts about the guardian,
 * the file a maintainer would open appears among the top results.
 *
 * Run with: node tests/egc-guardian-graph-selfbench.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'graph-context.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { buildRelevantContext } = require(path.join(buildDir, 'graph-context.js'));

const repoRoot = path.resolve(__dirname, '..');
const CASES = [
  ['classify a chunk as json, code, log or diff before crushing it', 'egc-chunk-router.ts'],
  ['the prompt injection scanner should flag a new pattern', 'prompt-injection-scanner.ts'],
  ['validateCommand denies a dangerous git command', 'validator.ts'],
  ['write an audit log entry with redacted secrets', 'audit-log.ts'],
  ['open the sqlite database with the wasm fallback engine', 'sqlite-compat.ts'],
  ['the session bus announce and claim path functions', 'session-bus.ts'],
  ['encrypt the project state file at rest', 'encryption.ts'],
  ['search the memory history for past decisions', 'search.ts']
];

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-graph-selfbench-'));
  const env = { ...process.env, EGC_DIR: tmp };
  let failed = 0;
  for (const [prompt, expected] of CASES) {
    const r = await buildRelevantContext(prompt, path.join(repoRoot, 'mcp', 'servers'), 3000, { env });
    const top = (r.files || []).slice(0, 5).map(f => path.basename(f.path));
    const ok = r.status !== 'unavailable' && top.includes(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'} "${prompt}" -> ${expected} in [${top.join(', ')}]`);
    if (!ok) failed++;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${CASES.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run it and look at the failures**

Run: `node tests/egc-guardian-graph-selfbench.test.js`
Expected: most cases pass. For any miss, check first that the expected file really contains words from the prompt (fix the *prompt* if the case was badly chosen); change the ranking only if a clearly relevant file is missing for a general reason, and then re-run Tasks 4 and 5 tests. Keep at least 6 of the 8 passing and replace weak cases with ones that reflect real maintainer prompts rather than tuning the algorithm to the benchmark.

- [ ] **Step 3: Document it**

In `docs/token-optimization.md`, at the end of the Guardian paragraph (line 13, after "Use it instead of reading large files whole."), add: `` `orchestrate_task` also returns a `relevant_context` block: ranked snippets from the project's own JS/TS code, picked from a local graph of its files, symbols, imports and references (built on first use, cached under `~/.egc/graph/`, refreshed for changed files only, no network). Pass `project_path` when the server does not run in the project, and `context_budget_tokens` (200 to 8000, default 2000) to size it. `` Match the page's existing prose style (no double hyphens or dashes as punctuation; `tests/docs/no-double-hyphen-dashes.test.js` checks the installation and troubleshooting guides).

In `CHANGELOG.md`, under `## [Unreleased]` / `### Added`, add one entry in the file's existing style:

```markdown
- **`orchestrate_task` returns the code a task is about** (a code graph in the Guardian): the Guardian reads the project's JS/TS files with a dependency-free lexical extractor, keeps a graph of files, symbols, imports and references in `~/.egc/graph/` (built on the first call, then refreshed only for files whose size, time or content changed), and answers with a `relevant_context` block of ranked, token-budgeted snippets with the reason each is there (matched words, caller, callee, importer). Ranking is local and deterministic (identifier weighting, then a two-hop walk over the graph); nothing leaves the machine. It never indexes symlinks, `node_modules`, build output, `.gitignore` matches or protected files, drops snippets the injection scanner flags, redacts secrets, refuses a filesystem root or the home directory, and degrades to `relevant_context: { status: "unavailable" }` instead of failing the tool. `orchestrate_task` takes optional `project_path` and `context_budget_tokens`.
```

- [ ] **Step 4: Run the full suite and lint**

Run:

```bash
npm test
npm run lint
```

Expected: the whole suite passes (including `tests/docs/*` and the new `egc-guardian-graph-*` files) and lint is clean. Fix anything the new files introduce (for example prettier-style or eslint complaints in the test files).

- [ ] **Step 5: Commit**

```bash
git add tests/egc-guardian-graph-selfbench.test.js docs/token-optimization.md CHANGELOG.md
git commit -m "docs(guardian): document relevant_context and add a self-benchmark regression test"
```

---

## Self-Review

- **Spec coverage:** extractor (Task 1), store with version and recovery (2), walk/ignore/incremental/caps/symlinks/lock/edges (3), seeding/IDF/hops/budget/grouping/why (4), `project_path`/budget args, degrade-to-unavailable, audit counts only, injection scan, redaction, root and home refusal (5), benchmark and docs (6). The spec's "5,000 files and 20 seconds" caps are the defaults in `buildGraph`; the 1 MB file cap is `maxFileBytes`.
- **Spec deviations to note at review:** (a) `why` strings read `calls X` / `called by X` / `imports X` / `imported by X` (direction-aware); (b) edges are recomputed whole after any change (simpler and correct, still fast for the 5000-file cap); (c) an aliased export (`export { a as b }`) marks `a` exported, so an import of `b` links to the file, not the symbol.
- **Type consistency:** `ExtractResult`/`ImportBinding` (Task 1) feed `GraphStore.replaceFile` (2); `GraphData`/`SymbolRow` feed `computeEdges` (3) and `queryGraph` (4); `queryGraph` returns camelCase and `buildRelevantContext` maps to the snake_case wire shape (5).
- **Known approximations (by design, in the spec's risk list):** lexical extraction misses computed exports and class property arrow functions; `tsconfig` path aliases are not resolved; the token estimate is chars/4.
