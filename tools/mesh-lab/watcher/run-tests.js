'use strict';
// Entry point required by issue #1252: `node tools/mesh-lab/watcher/run-tests.js`
// runs the whole lab. Linux-only by charter (inotify semantics are the
// mission); other platforms and driver-less environments skip cleanly so the
// harness stays CI-friendly under any package manager.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { loadSqliteDriver } = require('./lib/deps');

if (process.platform !== 'linux') {
  console.log('[SKIP] the mesh-lab watcher prototype targets Linux inotify semantics.');
  process.exit(0);
}
if (!loadSqliteDriver()) {
  console.log('[SKIP] sqlite driver not resolvable from the repo root or the egc-memory server.');
  process.exit(0);
}

const suites = ['property-test.js', 'fd-test.js', 'load-test.js'];
let passed = 0;
let failed = 0;

console.log('=== mesh-lab watcher: push delivery over the session-bus WAL store ===');
for (const suite of suites) {
  const result = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  if (result.status === 0) passed += 1;
  else failed += 1;
}

console.log(`\n=== mesh-lab watcher summary: ${passed} suites passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
