'use strict';

// .gitignore re-includes whole trees (`!skills/**`, `!tests/**`, `!mcp/**`),
// which also re-included the caches Python leaves next to the scripts it
// runs; a `git add` of a skill folder then committed compiled .pyc files.
// The re-block section at the end of .gitignore must keep them out of every
// whitelisted tree.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');

// S4036: prefer fixed git locations over a PATH lookup, as session-end.js
// does; the bare name is the last resort for layouts like nix or portable Git.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

function isIgnored(relativePath) {
  const result = spawnSync(GIT_BIN, ['check-ignore', '--no-index', '-q', relativePath], { cwd: repoRoot });
  return result.status === 0;
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

console.log('\n=== Testing .gitignore for build and cache artifacts ===\n');

let passed = 0;
let failed = 0;

const PYTHON_CACHES = [
  'skills/ai/continuous-learning-v2/scripts/__pycache__/instinct-cli.cpython-313.pyc',
  'skills/ai/continuous-learning-v2/scripts/stray.pyc',
  'tests/__pycache__/test_x.cpython-313-pytest-9.1.1.pyc',
  'tests/hooks/__pycache__/x.cpython-313.pyc',
  'mcp/servers/egc-memory/__pycache__/x.pyc',
  'tests/.pytest_cache/v/cache/lastfailed',
  'skills/ai/continuous-learning-v2/.venv/lib/x.py',
  'skills/ai/continuous-learning-v2/venv/lib/x.py',
  'tests/egc.egg-info/PKG-INFO',
  'docs/.mypy_cache/3.13/x.data.json',
];

if (test('Python caches stay ignored inside every whitelisted tree', () => {
  for (const relativePath of PYTHON_CACHES) {
    assert.ok(isIgnored(relativePath), `${relativePath} is not ignored`);
  }
})) passed++; else failed++;

if (test('the sources next to those caches are still tracked', () => {
  for (const relativePath of ['skills/ai/continuous-learning-v2/scripts/instinct-cli.py', 'tests/test_egc_home_matches_node.py']) {
    assert.ok(!isIgnored(relativePath), `${relativePath} is ignored`);
  }
})) passed++; else failed++;

console.log(`\nPassed: ${passed}, Failed: ${failed}\n`);
// run-all.js reads this file's stdout through a pipe; process.exit() can
// truncate it before it flushes, losing the summary line it parses.
process.exitCode = failed > 0 ? 1 : 0;
