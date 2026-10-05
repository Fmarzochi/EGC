# Code Graph Context for `orchestrate_task` — Design

Date: 2026-10-05 · Status: draft for review · Branch: feat/my-contribution

## Goal

When `orchestrate_task` runs at the start of a task, it also returns a ranked slice of the project's own code (files, symbols, snippets) relevant to the task prompt, so the assistant does not have to blind-`Grep`/`Read` its way there. This reimplements the core idea of GrapeRoot (semantic graph of files, symbols, imports and call chains, used to pre-load the right code) natively in EGC. GrapeRoot is **not** a dependency and no code is copied from it.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Placement | Modules inside `mcp/servers/egc-guardian/src/`, exposed through `orchestrate_task`. No new MCP server or process. |
| Languages (v1) | JS/TS only (`.js .jsx .mjs .cjs .ts .tsx .mts .cts`). |
| Indexing | Lazy and cached: first call builds the graph, later calls refresh only files whose mtime/size/hash changed. No watcher, no manual build step. |
| Delivery | Inline in `orchestrate_task`'s JSON result as a `relevant_context` block (snippets, not whole files). |
| Relevance | Local and deterministic: weighted keyword seeding plus bounded graph expansion. No embeddings, no network. |
| Parsing | **Zero new dependencies**: a hand-written lexical extractor (see below). Tree-sitter was considered and rejected: it is a native module, and EGC already ships a wasm fallback for sqlite3 precisely because native loads fail on some machines. |

## Components

All new files live in `mcp/servers/egc-guardian/src/`.

- `graph-extract.ts` — pure function `extractFile(path, source) -> { symbols, imports, refs }`. A single-pass lexer that skips comments, strings, template literals and regex literals, tracks brace depth, and recognises: `import`/`export ... from`, `require()` and dynamic `import()` with string literals, top-level and exported `function`, `class`, `const/let/var` (arrow or function initialisers), class methods, and identifier references inside bodies (candidate calls). Records each symbol's start/end line. It is approximate by design: it never executes code and never fails hard; unparseable input yields an empty result for that file.
- `graph-store.ts` — SQLite persistence via the existing `sqlite-compat.ts`. File: `~/.egc/graph/<project-slug>.db` (same slug convention as `state-store-path.ts`). Tables: `files(path, mtime, size, hash)`, `symbols(id, file, name, kind, exported, start_line, end_line)`, `edges(src, dst, kind)` where kind is `import` or `ref`. Schema carries a `version` row; a mismatch drops and rebuilds.
- `graph-build.ts` — walks the project root, applies the ignore rules, diffs against `files`, re-extracts only changed files, deletes rows for removed files, resolves relative import specifiers to files (extension and `index.*` probing, `tsconfig` `paths` not supported in v1), and resolves `ref` edges by matching identifiers to symbols exported by imported files first, then same-file symbols.
- `graph-query.ts` — `queryGraph(prompt, opts) -> RelevantContext`: seeding, expansion, budget trim, snippet cutting (below).
- `index.ts` — `OrchestrateTaskSchema` gains optional `project_path` (default `process.cwd()`, which may not be the project when the host launches the server elsewhere) and `context_budget_tokens`. `handleOrchestrateTask` calls build then query and adds `relevant_context` to the result. Graph failure never fails the tool: it adds `relevant_context: { status: "unavailable", reason }` and the rest of the response is unchanged.

## Ranking

1. **Seeding.** Split the prompt into identifier-like tokens (camelCase/snake_case split, lowercased, stopwords dropped). Score each symbol and file by token overlap, weighted by inverse document frequency over all symbol/file names in the graph, so rare names such as `validateCommand` outweigh `index`. Exported symbols get a 1.2x boost; exact name matches a 2x boost. Keep the top N seeds (default 8).
2. **Expansion.** Bounded BFS from the seeds along `import` and `ref` edges in both directions (callers and callees), default 2 hops, score multiplied by 0.5 per hop. A node reached by several paths keeps its best score.
3. **Budget trim.** Sort by score; include each symbol's own line range (plus its signature line and 2 lines of context) until the token budget is reached (default 2000, estimated as characters/4). If a symbol alone exceeds 40% of the budget, include its signature and first lines only, marked truncated.
4. **Grouping.** Merge snippets of the same file into one entry with ordered, non-overlapping ranges.
5. **Explainability.** Each entry carries `why`: `matched "<token>"` for seeds or `imports <file>` / `called by <symbol>` for expanded nodes.

Output shape:

```json
"relevant_context": {
  "status": "ok",
  "files": [
    { "path": "mcp/servers/egc-guardian/src/validator.ts", "score": 4.2,
      "why": ["matched \"validate\""],
      "snippets": [{ "symbol": "validateCommand", "start_line": 10, "end_line": 48, "text": "..." }] }
  ],
  "tokens_estimated": 1840, "truncated": false,
  "graph": { "files": 212, "refreshed": 3, "build_ms": 41 }
}
```

## Data flow

`orchestrate_task(prompt, filepaths?, project_path?)` → resolve project root → open store → incremental build (stat all files, hash only those whose mtime or size changed) → query → attach `relevant_context` → return. The existing routing and `context_reduction` fields are untouched.

## Safety and error handling

- Project root is resolved with `realpath`; every indexed file must stay inside it (no symlink escapes). Reads reuse the hardened loader pattern from `loadContextFileChunks` (file-handle reads, `isFile()` check).
- Ignore: `.git`, `node_modules`, build/dist/coverage dirs, `.env*`, key/cert files (`*.pem`, `*.key`, `id_rsa*`), files over 1 MB, and anything matched by the root `.gitignore` (simple pattern support only). Secrets must never be embedded in a snippet returned to the model; snippet text additionally goes through the existing `prompt-injection-scanner` and any flagged snippet is dropped with a note.
- Caps: 5,000 files and 20 seconds per build; on hitting either, the partial graph is used and `status: "partial"` is reported. A concurrent build for the same project is serialised with a lock file; the second caller queries the existing graph.
- Corrupt or version-mismatched database: delete and rebuild once; on second failure return `unavailable`.
- Audit: log `GRAPH_BUILD` and `GRAPH_QUERY` events (counts and timings, never snippet text) via the existing `auditLog`.

## Testing

Unit tests under `tests/` following the existing runner (`tests/run-all.js`):

- `graph-extract`: fixtures for ES imports/exports, CommonJS, dynamic import, arrow-function consts, classes/methods, and traps (keywords inside strings, comments, template literals, regex literals).
- `graph-build`: incremental behaviour (unchanged files not re-read, deleted files removed, renamed import target re-resolved), ignore rules, symlink escape refused, caps.
- `graph-query`: IDF weighting, hop decay, budget trim, truncation, grouping, `why` strings, stable ordering on ties.
- `orchestrate_task` integration: result includes `relevant_context`; a failing graph degrades to `unavailable` without breaking routing; existing tests unchanged.
- A self-benchmark on this repo: for 10 sample prompts, check the expected file appears in the top results (recorded as a regression check, not a pass/fail accuracy claim).

## Out of scope for v1

Other languages, `tsconfig` path aliases, type-aware resolution, embeddings, a file watcher, a standalone `egc graph` CLI, and cross-repo graphs. Each can be added later without changing the `relevant_context` shape.

## Open risks

- Lexical extraction will miss some dynamic patterns (computed exports, re-export barrels with `export *` chains). Mitigation: `export *` is followed one level; misses degrade relevance, never correctness of the rest of the response.
- Token estimate (chars/4) is rough; the budget is a soft cap.
