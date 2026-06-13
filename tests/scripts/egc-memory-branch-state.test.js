/**
 * Tests for the egc-memory branch-state module.
 *
 * Tests the extracted branch resolution logic directly (no MCP server needed).
 * Run with: node tests/scripts/egc-memory-branch-state.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const MODULE_PATH = path.join(
  __dirname,
  '../../mcp/servers/egc-memory/build/branch-state.js'
);

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

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeGitRepo(branch) {
  const repo = makeTmpDir('egc-memory-branch-repo-');
  const git = (args) => execSync(`git ${args}`, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init -q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'test repo\n');
  git('add README.md');
  git('-c user.email=test@test -c user.name=test -c commit.gpgsign=false commit -q -m initial');
  if (branch) {
    git(`checkout -q -b ${branch}`);
  }
  return repo;
}

function writeState(filePath, marker) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `# Project State\n\n## Context\n${marker}\n`, 'utf8');
}

async function runTests() {
  let mod;
  try {
    mod = await import(MODULE_PATH);
  } catch (e) {
    console.log(
      `[SKIP] Could not import ${MODULE_PATH}. Run 'npm run build' in mcp/servers/egc-memory first.`
    );
    console.log(e.message);
    process.exit(0);
  }

  const api = mod.default && mod.default.projectSlug ? mod.default : mod;
  const {
    projectSlug,
    sanitizeBranchName,
    detectBranch,
    flatStateFile,
    branchStateFile,
    resolveStateRead,
    resolveStateWrite,
  } = api;

  console.log('\n=== Testing egc-memory build/branch-state.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('projectSlug matches the legacy slug format', () => {
    assert.strictEqual(projectSlug('/home/user/Projects/my-app'), 'Projects--my-app');
    assert.strictEqual(projectSlug(''), 'default');
  })) passed++; else failed++;

  if (test('sanitizeBranchName produces safe filenames', () => {
    assert.strictEqual(sanitizeBranchName('feature/auth'), 'feature-auth');
    assert.strictEqual(sanitizeBranchName('release/1.0.8'), 'release-1_0_8');
  })) passed++; else failed++;

  if (test('detectBranch returns the current branch and null outside repos', () => {
    const repo = makeGitRepo('hotfix/login');
    assert.strictEqual(detectBranch(repo), 'hotfix/login');
    assert.strictEqual(detectBranch(makeTmpDir('egc-memory-norepo-')), null);
  })) passed++; else failed++;

  if (test('resolveStateRead prefers branch file over main.md and flat', () => {
    const stateDir = makeTmpDir('egc-memory-read1-');
    const project = '/home/user/Projects/my-app';
    writeState(branchStateFile(stateDir, project, 'feature/auth'), 'branch');
    writeState(path.join(stateDir, 'Projects--my-app', 'main.md'), 'main');
    writeState(flatStateFile(stateDir, project), 'flat');

    const resolved = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(resolved.source, 'branch');
    assert.strictEqual(resolved.filePath, branchStateFile(stateDir, project, 'feature/auth'));
  })) passed++; else failed++;

  if (test('resolveStateRead falls back to main.md then flat', () => {
    const stateDir = makeTmpDir('egc-memory-read2-');
    const project = '/home/user/Projects/my-app';
    writeState(path.join(stateDir, 'Projects--my-app', 'main.md'), 'main');
    writeState(flatStateFile(stateDir, project), 'flat');

    const fromMain = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(fromMain.source, 'default-branch');

    fs.unlinkSync(path.join(stateDir, 'Projects--my-app', 'main.md'));
    const fromFlat = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(fromFlat.source, 'flat');
    assert.strictEqual(fromFlat.filePath, flatStateFile(stateDir, project));
  })) passed++; else failed++;

  if (test('resolveStateRead reports none when no state exists', () => {
    const stateDir = makeTmpDir('egc-memory-read3-');
    const project = '/home/user/Projects/my-app';
    const resolved = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(resolved.source, 'none');
    assert.strictEqual(resolved.filePath, branchStateFile(stateDir, project, 'feature/auth'));
  })) passed++; else failed++;

  if (test('resolveStateWrite scopes writes to the current branch', () => {
    const stateDir = '/tmp/fake-home/.egc/state';
    const project = '/home/user/Projects/my-app';
    assert.strictEqual(
      resolveStateWrite(stateDir, project, 'feature/auth'),
      branchStateFile(stateDir, project, 'feature/auth')
    );
    assert.strictEqual(
      resolveStateWrite(stateDir, project, null),
      flatStateFile(stateDir, project)
    );
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
