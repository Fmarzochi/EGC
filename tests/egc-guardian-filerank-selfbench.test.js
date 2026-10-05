'use strict';
/**
 * Real-world check on this repository: for maintainer-style tasks, the file a
 * maintainer would open first is in the top 10 ranked files.
 *
 * Run with: node tests/egc-guardian-filerank-selfbench.test.js
 */
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'file-rank.js');
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
