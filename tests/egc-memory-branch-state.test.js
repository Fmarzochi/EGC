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
  branchStateKey,
  legacyBranchStateFile,
  projectKey,
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

// A project keyed by its origin remote (#2063): the keyed directory is tried
// before the slug of the path at every step, so a document written by this
// version shadows the one an older version wrote, and the older one is still
// read when nothing newer exists.
// The repository is laid out by hand (HEAD and config are all the reader
// opens), so this file needs no git on the machine.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-branch-identity-'));
fs.mkdirSync(path.join(repo, '.git'));
fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/Owner/Repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
const keyedDir = path.join(stateDir, projectKey(repo));
const legacyDir = path.join(stateDir, projectSlug(repo));
fs.mkdirSync(keyedDir, { recursive: true });
fs.mkdirSync(legacyDir, { recursive: true });
const ownName = `${branchStateKey(featureBranch)}.md`;
const mainName = `${branchStateKey('main')}.md`;

run('own file under the remote key wins over the own file under the path slug', () => {
  assert.notStrictEqual(keyedDir, legacyDir);
  fs.writeFileSync(path.join(keyedDir, ownName), 'keyed-own');
  fs.writeFileSync(path.join(legacyDir, ownName), 'legacy-own');
  const resolved = resolveStateRead(stateDir, repo, featureBranch);
  assert.strictEqual(resolved.filePath, path.join(keyedDir, ownName));
  assert.strictEqual(resolved.source, 'branch');
  fs.rmSync(path.join(keyedDir, ownName));
});

run('own file under the path slug wins over the default branch under the remote key', () => {
  fs.writeFileSync(path.join(keyedDir, mainName), 'keyed-main');
  const resolved = resolveStateRead(stateDir, repo, featureBranch);
  assert.strictEqual(resolved.filePath, path.join(legacyDir, ownName));
  assert.strictEqual(resolved.source, 'branch');
  fs.rmSync(path.join(legacyDir, ownName));
});

run('default branch under the remote key wins over the default branch under the path slug', () => {
  fs.writeFileSync(path.join(legacyDir, mainName), 'legacy-main');
  fs.writeFileSync(path.join(legacyDir, 'main.md'), 'legacy-plain-main');
  const resolved = resolveStateRead(stateDir, repo, featureBranch);
  assert.strictEqual(resolved.filePath, path.join(keyedDir, mainName));
  assert.strictEqual(resolved.source, 'default-branch');
  fs.rmSync(path.join(keyedDir, mainName));
});

run('the default branch under the path slug is still read when the remote key holds nothing', () => {
  const hashed = resolveStateRead(stateDir, repo, featureBranch);
  assert.strictEqual(hashed.filePath, path.join(legacyDir, mainName));
  assert.strictEqual(hashed.source, 'default-branch');
  fs.rmSync(path.join(legacyDir, mainName));
  const plain = resolveStateRead(stateDir, repo, featureBranch);
  assert.strictEqual(plain.filePath, path.join(legacyDir, 'main.md'));
  assert.strictEqual(plain.source, 'default-branch');
});

run('with nothing written yet, the project is created under the remote key', () => {
  fs.rmSync(path.join(legacyDir, 'main.md'));
  const none = resolveStateRead(stateDir, repo, featureBranch);
  assert.strictEqual(none.source, 'none');
  assert.strictEqual(none.filePath, path.join(keyedDir, ownName));
  assert.strictEqual(branchStateFile(stateDir, repo, featureBranch), none.filePath);
});

fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(stateDir, { recursive: true, force: true });

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
