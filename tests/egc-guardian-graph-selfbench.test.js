'use strict';
/**
 * Regression check on this repository: for sample prompts about the guardian,
 * the file a maintainer would open appears among the top results.
 *
 * Run with: node tests/egc-guardian-graph-selfbench.test.js
 */
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

// A cold build stops at its deadline and answers from what it has indexed so
// far. A loaded runner does not get through the tree in one go, and the first
// case then ran on a partial graph and missed its file. The cases are about
// ranking, so the graph is built to the end first: each call resumes the
// build, and a round that refreshes nothing has nothing left to index.
const MAX_BUILD_ROUNDS = 10;

async function buildWholeGraph(root, env) {
  for (let round = 0; round < MAX_BUILD_ROUNDS; round += 1) {
    let refreshed = -1;
    const audit = (action, details) => {
      if (action === 'GRAPH_BUILD') refreshed = details.refreshed;
    };
    const r = await buildRelevantContext('build the graph', root, 3000, { env, audit });
    if (r.status === 'ok' || refreshed === 0) return true;
  }
  return false;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-graph-selfbench-'));
  const env = { ...process.env, EGC_DIR: tmp };
  const serversRoot = path.join(repoRoot, 'mcp', 'servers');
  let failed = 0;
  try {
    if (!(await buildWholeGraph(serversRoot, env))) {
      console.log(`  FAIL the graph was still being built after ${MAX_BUILD_ROUNDS} rounds`);
      failed++;
    }
    for (const [prompt, expected] of CASES) {
      const r = await buildRelevantContext(prompt, serversRoot, 3000, { env });
      const top = (r.files || []).slice(0, 5).map(f => path.basename(f.path));
      const ok = r.status !== 'unavailable' && top.includes(expected);
      console.log(`  ${ok ? 'PASS' : 'FAIL'} "${prompt}" -> ${expected} in [${top.join(', ')}]`);
      if (!ok) failed++;
    }
  } finally {
    // Removed whether a case threw or not: the graph database lives under it.
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  console.log(`\n${CASES.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
