'use strict';
/**
 * Tests for scripts/check-internal-tool-leak.js
 *
 * Covers the internal/personal tool name guard: a denylisted term must be
 * caught in staged blobs (--staged), the tracked tree (--tree), and
 * arbitrary text (--text, used for PR title/body in CI).
 *
 * Run with: node tests/check-internal-tool-leak.test.js
 */
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-internal-tool-leak.js');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-tool-leak-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'check-internal-tool-leak.js'));
  return { dir, git };
}

function runScript(dir, ...args) {
  return spawnSync('node', [path.join(dir, 'scripts', 'check-internal-tool-leak.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
const run = (name, fn) => { if (test(name, fn)) passed++; else failed++; };

console.log('\n=== Testing check-internal-tool-leak ===\n');

run('staged file mentioning the denylisted term is blocked', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'NOTES.md'), 'An independent Multica audit found 3 bugs.\n');
  git('add', 'NOTES.md');
  const res = runScript(dir, '--staged');
  assert.strictEqual(res.status, 1, `expected exit 1, got ${res.status}: ${res.stderr}`);
  assert.ok(res.stderr.includes('multica'));
});

run('case-insensitive match is caught', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'NOTES.md'), 'Found by MULTICA security review.\n');
  git('add', 'NOTES.md');
  const res = runScript(dir, '--staged');
  assert.strictEqual(res.status, 1);
});

run('tree mode flags a committed file', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'NOTES.md'), 'multica pass found 3 bugs\n');
  git('add', 'NOTES.md');
  git('commit', '-q', '-m', 'seed', '--no-verify');
  const res = runScript(dir, '--tree');
  assert.strictEqual(res.status, 1);
  assert.ok(res.stderr.includes('NOTES.md'));
});

run('clean staged content passes', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'NOTES.md'), 'An independent security audit found 3 bugs.\n');
  git('add', 'NOTES.md');
  const res = runScript(dir, '--staged');
  assert.strictEqual(res.status, 0, res.stderr);
});

run('--text mode blocks a leaking string', () => {
  const { dir } = makeRepo();
  const res = runScript(dir, '--text', 'fix: bypasses found by Multica security audit');
  assert.strictEqual(res.status, 1);
});

run('--text mode passes clean text', () => {
  const { dir } = makeRepo();
  const res = runScript(dir, '--text', 'fix: bypasses found by an internal security audit');
  assert.strictEqual(res.status, 0, res.stderr);
});

run('--text-file mode blocks a leaking file (no argv size limit)', () => {
  const { dir } = makeRepo();
  const file = path.join(dir, 'pr-text.txt');
  fs.writeFileSync(file, 'fix: bypasses found by Multica security audit');
  const res = runScript(dir, '--text-file', file);
  assert.strictEqual(res.status, 1);
});

run('--text-file mode passes a clean file', () => {
  const { dir } = makeRepo();
  const file = path.join(dir, 'pr-text.txt');
  fs.writeFileSync(file, 'fix: bypasses found by an internal security audit');
  const res = runScript(dir, '--text-file', file);
  assert.strictEqual(res.status, 0, res.stderr);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
