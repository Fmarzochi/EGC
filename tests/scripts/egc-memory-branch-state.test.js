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
    branchStateKey,
    detectBranch,
    detectDetachedCommit,
    resolveHeadState,
    flatStateFile,
    branchStateFile,
    detachedStateFile,
    legacyBranchStateFile,
    resolveStateRead,
    resolveStateWrite,
    trustedGitPath,
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

  if (test('branchStateKey distinguishes names with the same legacy filename', () => {
    assert.notStrictEqual(branchStateKey('feature/auth'), branchStateKey('feature-auth'));
    assert.notStrictEqual(branchStateKey('release/1.0'), branchStateKey('release-1_0'));
  })) passed++; else failed++;

  if (test('detectBranch returns the current branch and null outside repos', () => {
    const repo = makeGitRepo('hotfix/login');
    assert.strictEqual(detectBranch(repo), 'hotfix/login');
    assert.strictEqual(detectBranch(makeTmpDir('egc-memory-norepo-')), null);
  })) passed++; else failed++;

  if (test('trustedGitPath refuses a .git path outside the home and temp roots (#1802)', () => {
    const realTmp = fs.realpathSync.native(os.tmpdir());
    const under = path.join(realTmp, 'egc-trusted', '.git', 'HEAD');
    assert.strictEqual(
      trustedGitPath(path.join(os.tmpdir(), 'egc-trusted', 'sub', '..', '.git', 'HEAD')),
      under,
      'resolved, normalised and canonical, same as scripts/lib/branch-state.js'
    );
    assert.strictEqual(trustedGitPath(path.join(os.tmpdir(), 'egc-trusted', 'HEAD')), null, 'no .git segment');
    const outside = path.join(path.parse(realTmp).root, 'egc-nowhere', '.git', 'HEAD');
    assert.strictEqual(trustedGitPath(outside), null, 'outside the home and temp roots');

    if (process.platform !== 'win32') {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-memory-trusted-link-'));
      try {
        // A link at .git pointing outside both roots: the lexical path looks
        // inside the temp root, the canonical one does not.
        fs.symlinkSync(path.parse(realTmp).root, path.join(base, '.git'), 'dir');
        assert.strictEqual(trustedGitPath(path.join(base, '.git', 'HEAD')), null, 'a link leading outside the roots is refused');
        // A link that stays inside the temp root is followed and accepted.
        fs.mkdirSync(path.join(base, 'real', '.git'), { recursive: true });
        fs.symlinkSync(path.join(base, 'real'), path.join(base, 'alias'), 'dir');
        assert.strictEqual(
          trustedGitPath(path.join(base, 'alias', '.git', 'HEAD')),
          path.join(fs.realpathSync.native(base), 'real', '.git', 'HEAD'),
          'a link inside the roots resolves to its canonical target'
        );
        // A link loop cannot be canonicalised: refused.
        fs.symlinkSync(path.join(base, 'loop'), path.join(base, 'loop'));
        assert.strictEqual(trustedGitPath(path.join(base, 'loop', '.git', 'HEAD')), null, 'a link loop is refused');
        // A dangling link on the way is refused too: its target could be
        // created or moved later and redirect the read past the check.
        fs.symlinkSync(path.join(base, 'not-yet'), path.join(base, 'dangling'));
        assert.strictEqual(trustedGitPath(path.join(base, 'dangling', '.git', 'HEAD')), null, 'a dangling link on the way is refused');
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }
  })) passed++; else failed++;

  if (test('readHeadLine refuses to follow a symlink planted at HEAD after validation, even when the link target is itself a trusted .git path (#1807 TOCTOU narrowing)', () => {
    if (process.platform === 'win32') return; // symlink creation needs elevated privileges on Windows
    // The victim is a second, otherwise-legitimate repo under the same
    // trusted root: trustedGitPath's canonicalization would accept a link
    // to it (the resolved target has a .git segment and sits under the
    // trusted root too), so the real test of O_NOFOLLOW is exactly this
    // case, not a link to a path trustedGitPath would reject anyway.
    const repo = makeGitRepo('feature/toctou');
    const victimRepo = makeGitRepo('attacker-controlled');
    const headPath = path.join(repo, '.git', 'HEAD');
    const victimHead = path.join(victimRepo, '.git', 'HEAD');
    const realHead = fs.readFileSync(headPath, 'utf8');
    fs.rmSync(headPath);
    fs.symlinkSync(victimHead, headPath);

    try {
      assert.strictEqual(detectBranch(repo), null, 'a symlinked HEAD must be refused even when its target is itself a trusted .git/HEAD');
    } finally {
      fs.rmSync(headPath);
      fs.writeFileSync(headPath, realHead);
      fs.rmSync(victimRepo, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('detectDetachedCommit returns the commit on detached HEAD, null on a branch or outside a repo', () => {
    const onBranch = makeGitRepo('hotfix/login');
    assert.strictEqual(detectDetachedCommit(onBranch), null);

    const repo = makeGitRepo(null);
    execSync('git checkout -q --detach', { cwd: repo });
    const commit = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    assert.strictEqual(detectDetachedCommit(repo), commit);

    assert.strictEqual(detectDetachedCommit(makeTmpDir('egc-memory-norepo-')), null);
  })) passed++; else failed++;

  if (test('detectDetachedCommit accepts a SHA-256 repository commit (64 hex characters)', () => {
    const repo = makeTmpDir('egc-memory-sha256-');
    const git = (args) => execSync(`git ${args}`, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init -q --object-format=sha256');
    git('-c user.email=test@test -c user.name=test -c commit.gpgsign=false commit -q -m initial --allow-empty');
    git('checkout -q --detach');
    const commit = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    assert.strictEqual(commit.length, 64);
    assert.strictEqual(detectDetachedCommit(repo), commit);
  })) passed++; else failed++;

  if (test('resolveHeadState pairs branch and detachedCommit consistently', () => {
    const onBranch = makeGitRepo('hotfix/login');
    assert.deepStrictEqual(resolveHeadState(onBranch), { branch: 'hotfix/login', detachedCommit: null });

    const repo = makeGitRepo(null);
    execSync('git checkout -q --detach', { cwd: repo });
    const commit = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    assert.deepStrictEqual(resolveHeadState(repo), { branch: null, detachedCommit: commit });
  })) passed++; else failed++;

  if (test('resolveStateRead and resolveStateWrite isolate detached HEAD by commit, never the shared flat file', () => {
    const stateDir = makeTmpDir('egc-memory-detached-');
    const project = '/home/user/Projects/my-app';
    const commitA = 'a'.repeat(40);
    const commitB = 'b'.repeat(40);

    assert.strictEqual(
      resolveStateWrite(stateDir, project, null, commitA),
      detachedStateFile(stateDir, project, commitA)
    );
    assert.notStrictEqual(detachedStateFile(stateDir, project, commitA), flatStateFile(stateDir, project));

    writeState(flatStateFile(stateDir, project), 'flat, shared by every non-branch checkout');
    writeState(detachedStateFile(stateDir, project, commitA), 'detached state for commit A');

    const resolvedA = resolveStateRead(stateDir, project, null, commitA);
    assert.strictEqual(resolvedA.source, 'detached');
    assert.strictEqual(resolvedA.filePath, detachedStateFile(stateDir, project, commitA));

    const resolvedB = resolveStateRead(stateDir, project, null, commitB);
    assert.strictEqual(resolvedB.source, 'none');

    const withoutDetached = resolveStateRead(stateDir, project, null);
    assert.strictEqual(withoutDetached.source, 'flat');
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

  if (test('resolveStateRead supports legacy sanitized branch filenames', () => {
    const stateDir = makeTmpDir('egc-memory-legacy-');
    const project = '/home/user/Projects/my-app';
    const legacyFile = legacyBranchStateFile(stateDir, project, 'feature/auth');
    writeState(legacyFile, 'legacy branch');

    const resolved = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(resolved.source, 'branch');
    assert.strictEqual(resolved.filePath, legacyFile);
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
