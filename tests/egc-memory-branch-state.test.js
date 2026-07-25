'use strict';
/**
 * Tests for scripts/lib/branch-state.js (mirrored by
 * mcp/servers/egc-memory/src/branch-state.ts).
 *
 * Covers resolveStateRead precedence: the branch's own hashed file first,
 * then the branch's legacy sanitized name, then the default branch, where
 * the hashed main file written by current versions must win over the plain
 * main.md left behind by pre-hash versions. That legacy file otherwise
 * shadows newer state forever on any feature branch without its own state.
 *
 * Run with: node tests/egc-memory-branch-state.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  branchStateFile,
  legacyBranchStateFile,
  projectSlug,
  resolveStateRead,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'branch-state.js'));

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

console.log('\n=== Testing egc-memory branch state resolution ===\n');

const projectPath = '/home/user/Projetos/EGC';
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-branch-state-'));
const slugDir = path.join(stateDir, projectSlug(projectPath));
fs.mkdirSync(slugDir, { recursive: true });

const hashedMain = branchStateFile(stateDir, projectPath, 'main');
const legacyMain = path.join(slugDir, 'main.md');
const featureBranch = 'feature/new-thing';

run('branch with its own hashed file wins over everything', () => {
  const own = branchStateFile(stateDir, projectPath, featureBranch);
  fs.writeFileSync(own, 'own');
  fs.writeFileSync(hashedMain, 'hashed');
  fs.writeFileSync(legacyMain, 'legacy');
  const resolved = resolveStateRead(stateDir, projectPath, featureBranch);
  assert.strictEqual(resolved.filePath, own);
  assert.strictEqual(resolved.source, 'branch');
  fs.rmSync(own);
});

run('branch legacy sanitized file wins over the default branch fallback', () => {
  const legacyOwn = legacyBranchStateFile(stateDir, projectPath, featureBranch);
  fs.writeFileSync(legacyOwn, 'legacy-own');
  const resolved = resolveStateRead(stateDir, projectPath, featureBranch);
  assert.strictEqual(resolved.filePath, legacyOwn);
  assert.strictEqual(resolved.source, 'branch');
  fs.rmSync(legacyOwn);
});

run('default fallback prefers the hashed main file over legacy main.md', () => {
  const resolved = resolveStateRead(stateDir, projectPath, featureBranch);
  assert.strictEqual(resolved.filePath, hashedMain);
  assert.strictEqual(resolved.source, 'default-branch');
});

run('default fallback still reads legacy main.md when no hashed main exists', () => {
  fs.rmSync(hashedMain);
  const resolved = resolveStateRead(stateDir, projectPath, featureBranch);
  assert.strictEqual(resolved.filePath, legacyMain);
  assert.strictEqual(resolved.source, 'default-branch');
});

run('reading the main branch itself resolves to its hashed file', () => {
  fs.writeFileSync(hashedMain, 'hashed');
  const resolved = resolveStateRead(stateDir, projectPath, 'main');
  assert.strictEqual(resolved.filePath, hashedMain);
  assert.strictEqual(resolved.source, 'branch');
});

fs.rmSync(stateDir, { recursive: true, force: true });

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
