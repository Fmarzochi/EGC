'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const {
  getStateDir,
  projectSlug,
  sanitizeBranchName,
  branchStateKey,
  detectBranch,
  flatStateFile,
  branchStateFile,
  legacyBranchStateFile,
  resolveStateRead,
  resolveStateWrite,
} = require('../../scripts/lib/branch-state');

const { collectMemoryState } = require('../../scripts/status');

const HOOK_PATH = path.join(__dirname, '../../scripts/hooks/egc-memory-load.js');

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

function git(cwd, args) {
  execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function makeGitRepo(branch) {
  const repo = makeTmpDir('egc-branch-state-repo-');
  git(repo, 'init -q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'test repo\n');
  git(repo, 'add README.md');
  git(repo, '-c user.email=test@test -c user.name=test -c commit.gpgsign=false commit -q -m initial');
  if (branch) {
    git(repo, `checkout -q -b ${branch}`);
  }
  return repo;
}

function writeState(filePath, marker) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `# Project State\n\n## Context\n${marker}\n`, 'utf8');
}

function runTests() {
  console.log('\n=== Testing branch-state.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('projectSlug uses last two path segments', () => {
    assert.strictEqual(projectSlug('/home/user/Projects/my-app'), 'Projects--my-app');
  })) passed++; else failed++;

  if (test('projectSlug sanitizes unsafe characters', () => {
    assert.strictEqual(projectSlug('/home/user/Pro jects/my.app'), 'Pro_jects--my_app');
  })) passed++; else failed++;

  if (test('projectSlug falls back to default for empty path', () => {
    assert.strictEqual(projectSlug(''), 'default');
  })) passed++; else failed++;

  if (test('sanitizeBranchName replaces slashes with hyphens', () => {
    assert.strictEqual(sanitizeBranchName('feature/auth'), 'feature-auth');
    assert.strictEqual(sanitizeBranchName('hotfix/login/v2'), 'hotfix-login-v2');
  })) passed++; else failed++;

  if (test('sanitizeBranchName strips unsafe filename characters', () => {
    assert.strictEqual(sanitizeBranchName('release/1.0.8'), 'release-1_0_8');
    assert.strictEqual(sanitizeBranchName('fix/issue#137'), 'fix-issue_137');
  })) passed++; else failed++;

  if (test('branchStateKey prevents collisions after filename sanitization', () => {
    assert.match(branchStateKey('feature/auth'), /^feature-auth--[0-9a-f]{64}$/);
    assert.notStrictEqual(branchStateKey('feature/auth'), branchStateKey('feature-auth'));
    assert.notStrictEqual(branchStateKey('release/1.0'), branchStateKey('release-1_0'));
  })) passed++; else failed++;

  if (test('getStateDir resolves under the provided home directory', () => {
    assert.strictEqual(getStateDir('/tmp/fake-home'), path.join('/tmp/fake-home', '.egc', 'state'));
  })) passed++; else failed++;

  if (test('detectBranch returns the current branch in a git repo', () => {
    const repo = makeGitRepo('feature/auth');
    assert.strictEqual(detectBranch(repo), 'feature/auth');
  })) passed++; else failed++;

  if (test('detectBranch returns null outside a git repo', () => {
    const dir = makeTmpDir('egc-branch-state-norepo-');
    assert.strictEqual(detectBranch(dir), null);
  })) passed++; else failed++;

  if (test('detectBranch returns null on detached HEAD', () => {
    const repo = makeGitRepo(null);
    git(repo, 'checkout -q --detach');
    assert.strictEqual(detectBranch(repo), null);
  })) passed++; else failed++;

  if (test('flatStateFile and branchStateFile build expected paths', () => {
    const stateDir = '/tmp/fake-home/.egc/state';
    const project = '/home/user/Projects/my-app';
    assert.strictEqual(
      flatStateFile(stateDir, project),
      path.join(stateDir, 'Projects--my-app.md')
    );
    assert.strictEqual(
      branchStateFile(stateDir, project, 'feature/auth'),
      path.join(stateDir, 'Projects--my-app', `${branchStateKey('feature/auth')}.md`)
    );
  })) passed++; else failed++;

  if (test('colliding legacy branch names write to independent state files', () => {
    const stateDir = makeTmpDir('egc-branch-state-collision-');
    const project = '/home/user/Projects/my-app';
    const slashBranchFile = branchStateFile(stateDir, project, 'feature/auth');
    const dashBranchFile = branchStateFile(stateDir, project, 'feature-auth');

    assert.notStrictEqual(slashBranchFile, dashBranchFile);
    writeState(slashBranchFile, 'slash branch');
    writeState(dashBranchFile, 'dash branch');
    assert.match(fs.readFileSync(slashBranchFile, 'utf8'), /slash branch/);
    assert.match(fs.readFileSync(dashBranchFile, 'utf8'), /dash branch/);
  })) passed++; else failed++;

  if (test('resolveStateRead prefers the current branch file', () => {
    const stateDir = makeTmpDir('egc-branch-state-read1-');
    const project = '/home/user/Projects/my-app';
    writeState(branchStateFile(stateDir, project, 'feature/auth'), 'branch state');
    writeState(path.join(stateDir, 'Projects--my-app', 'main.md'), 'main state');
    writeState(flatStateFile(stateDir, project), 'flat state');

    const resolved = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(resolved.source, 'branch');
    assert.strictEqual(resolved.filePath, branchStateFile(stateDir, project, 'feature/auth'));
  })) passed++; else failed++;

  if (test('resolveStateRead falls back to main.md when branch file is missing', () => {
    const stateDir = makeTmpDir('egc-branch-state-read2-');
    const project = '/home/user/Projects/my-app';
    writeState(path.join(stateDir, 'Projects--my-app', 'main.md'), 'main state');

    const resolved = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(resolved.source, 'default-branch');
    assert.strictEqual(resolved.filePath, path.join(stateDir, 'Projects--my-app', 'main.md'));
  })) passed++; else failed++;

  if (test('resolveStateRead migrates safely from legacy branch filenames', () => {
    const stateDir = makeTmpDir('egc-branch-state-legacy-');
    const project = '/home/user/Projects/my-app';
    const legacyFile = legacyBranchStateFile(stateDir, project, 'feature/auth');
    const currentFile = branchStateFile(stateDir, project, 'feature/auth');
    writeState(legacyFile, 'legacy branch state');

    const fromLegacy = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(fromLegacy.source, 'branch');
    assert.strictEqual(fromLegacy.filePath, legacyFile);

    writeState(currentFile, 'current branch state');
    const fromCurrent = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(fromCurrent.filePath, currentFile);
  })) passed++; else failed++;

  if (test('resolveStateRead falls back to the legacy flat file', () => {
    const stateDir = makeTmpDir('egc-branch-state-read3-');
    const project = '/home/user/Projects/my-app';
    writeState(flatStateFile(stateDir, project), 'flat state');

    const resolved = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(resolved.source, 'flat');
    assert.strictEqual(resolved.filePath, flatStateFile(stateDir, project));
  })) passed++; else failed++;

  if (test('resolveStateRead reads the flat file when there is no branch', () => {
    const stateDir = makeTmpDir('egc-branch-state-read4-');
    const project = '/home/user/Projects/my-app';
    writeState(flatStateFile(stateDir, project), 'flat state');

    const resolved = resolveStateRead(stateDir, project, null);
    assert.strictEqual(resolved.source, 'flat');
    assert.strictEqual(resolved.filePath, flatStateFile(stateDir, project));
  })) passed++; else failed++;

  if (test('resolveStateRead reports none when no state exists', () => {
    const stateDir = makeTmpDir('egc-branch-state-read5-');
    const project = '/home/user/Projects/my-app';

    const withBranch = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(withBranch.source, 'none');
    assert.strictEqual(withBranch.filePath, branchStateFile(stateDir, project, 'feature/auth'));

    const withoutBranch = resolveStateRead(stateDir, project, null);
    assert.strictEqual(withoutBranch.source, 'none');
    assert.strictEqual(withoutBranch.filePath, flatStateFile(stateDir, project));
  })) passed++; else failed++;

  if (test('resolveStateWrite targets the branch file when a branch exists', () => {
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

  if (test('collectMemoryState reports the active branch state', () => {
    const home = makeTmpDir('egc-branch-state-home1-');
    const repo = makeGitRepo('feature/auth');
    const stateFile = branchStateFile(getStateDir(home), repo, 'feature/auth');
    writeState(stateFile, 'branch state');

    const result = collectMemoryState(repo, home);
    assert.strictEqual(result.branch, 'feature/auth');
    assert.strictEqual(result.source, 'branch');
    assert.strictEqual(result.stateFile, stateFile);
    assert.strictEqual(result.slug, projectSlug(repo));
  })) passed++; else failed++;

  if (test('collectMemoryState reports flat fallback and missing state', () => {
    const home = makeTmpDir('egc-branch-state-home2-');
    const repo = makeGitRepo('feature/auth');
    writeState(flatStateFile(getStateDir(home), repo), 'flat state');

    const flat = collectMemoryState(repo, home);
    assert.strictEqual(flat.source, 'flat');
    assert.strictEqual(flat.stateFile, flatStateFile(getStateDir(home), repo));

    const emptyHome = makeTmpDir('egc-branch-state-home3-');
    const none = collectMemoryState(repo, emptyHome);
    assert.strictEqual(none.source, 'none');
    assert.strictEqual(none.stateFile, null);
  })) passed++; else failed++;

  if (test('egc-memory-load hook injects the branch state', () => {
    const home = makeTmpDir('egc-branch-state-home4-');
    const repo = makeGitRepo('feature/auth');
    writeState(branchStateFile(getStateDir(home), repo, 'feature/auth'), 'BRANCH_MARKER_137');
    writeState(flatStateFile(getStateDir(home), repo), 'FLAT_MARKER_137');

    const result = spawnSync('node', [HOOK_PATH], {
      input: '{}',
      encoding: 'utf8',
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, PWD: repo }),
      cwd: repo,
    });

    assert.strictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.ok(output.promptForAssistant.includes('BRANCH_MARKER_137'));
    assert.ok(!output.promptForAssistant.includes('FLAT_MARKER_137'));
  })) passed++; else failed++;

  if (test('egc-memory-load hook falls back to the flat state', () => {
    const home = makeTmpDir('egc-branch-state-home5-');
    const repo = makeGitRepo('feature/auth');
    writeState(flatStateFile(getStateDir(home), repo), 'FLAT_MARKER_137');

    const result = spawnSync('node', [HOOK_PATH], {
      input: '{}',
      encoding: 'utf8',
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, PWD: repo }),
      cwd: repo,
    });

    assert.strictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.ok(output.promptForAssistant.includes('FLAT_MARKER_137'));
  })) passed++; else failed++;

  if (test('egc-memory-load hook passes input through when no state exists', () => {
    const home = makeTmpDir('egc-branch-state-home6-');
    const repo = makeGitRepo('feature/auth');

    const result = spawnSync('node', [HOOK_PATH], {
      input: '{"session":"abc"}',
      encoding: 'utf8',
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, PWD: repo }),
      cwd: repo,
    });

    assert.strictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.session, 'abc');
    assert.strictEqual(output.promptForAssistant, undefined);
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
