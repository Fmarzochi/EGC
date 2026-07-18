'use strict';
/**
 * Tests for scripts/check-state-leak.js
 *
 * Covers the commit-privacy guard: populated EGC memory in propagation files
 * must be caught in staged blobs (--staged), in the tracked tree (--tree),
 * and --clean must zero the section so the same content passes.
 *
 * Run with: node tests/check-state-leak.test.js
 */
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-state-leak.js');

const POPULATED = [
  '# EGC: Agent Catalog',
  '',
  '<!-- egc:start -->',
  '<!-- egc:state-updated:2026-07-18T05:15:28.038Z -->',
  '## EGC Project Memory',
  '',
  '**Context:** secret local context that must never ship.',
  '',
  '**Active decisions:**',
  '- private decision one',
  '',
  '**Next session:**',
  '- private next step',
  '',
  '## EGC Triggers',
  '<!-- egc:end -->',
  '',
].join('\n');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-leak-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'check-state-leak.js'));
  return { dir, git };
}

function runScript(dir, ...args) {
  return spawnSync('node', [path.join(dir, 'scripts', 'check-state-leak.js'), ...args], {
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

console.log('\n=== Testing check-state-leak ===\n');

run('staged populated propagation file is blocked', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), POPULATED);
  git('add', 'AGENTS.md');
  const res = runScript(dir, '--staged');
  assert.strictEqual(res.status, 1, `expected exit 1, got ${res.status}: ${res.stderr}`);
  assert.ok(res.stderr.includes('AGENTS.md'));
});

run('cleaned file passes staged check and keeps structure', () => {
  const { dir, git } = makeRepo();
  const file = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(file, POPULATED);
  const cleanRes = runScript(dir, '--clean', 'AGENTS.md');
  assert.strictEqual(cleanRes.status, 0, cleanRes.stderr);
  const cleaned = fs.readFileSync(file, 'utf8');
  assert.ok(cleaned.includes('## EGC Project Memory'), 'structure heading survives');
  assert.ok(!cleaned.includes('secret local context'), 'context content removed');
  assert.ok(!cleaned.includes('private decision'), 'decisions removed');
  assert.ok(!cleaned.includes('state-updated'), 'stamp removed');
  git('add', 'AGENTS.md');
  const res = runScript(dir, '--staged');
  assert.strictEqual(res.status, 0, res.stderr);
});

run('tree mode flags committed populated file', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'GEMINI.md'), POPULATED);
  git('add', '.');
  git('commit', '-q', '-m', 'seed', '--no-verify');
  const res = runScript(dir, '--tree');
  assert.strictEqual(res.status, 1);
  assert.ok(res.stderr.includes('GEMINI.md'));
});

run('markdown without the managed section is ignored', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'README.md'), '# Readme\n\n**Context:** docs example\n');
  git('add', '.');
  const staged = runScript(dir, '--staged');
  assert.strictEqual(staged.status, 0, staged.stderr);
  git('commit', '-q', '-m', 'seed', '--no-verify');
  const tree = runScript(dir, '--tree');
  assert.strictEqual(tree.status, 0, tree.stderr);
});

run('non-markdown staged files are ignored', () => {
  const { dir, git } = makeRepo();
  fs.writeFileSync(path.join(dir, 'propagate.js'), `const s = '<!-- egc:state-updated:x -->';\nconst h = '## EGC Project Memory';\n`);
  git('add', 'propagate.js');
  const res = runScript(dir, '--staged');
  assert.strictEqual(res.status, 0, res.stderr);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
