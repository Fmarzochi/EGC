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
  detectDetachedCommit,
  resolveHeadState,
  flatStateFile,
  branchStateFile,
  detachedStateFile,
  legacyBranchStateFile,
  resolveStateRead,
  resolveStateWrite,
  trustedGitPath,
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
  const tally = ok => (ok ? passed++ : failed++);

  tally(test('projectSlug uses last two path segments', () => {
    assert.strictEqual(projectSlug('/home/user/Projects/my-app'), 'Projects--my-app');
  }));

  tally(test('projectSlug sanitizes unsafe characters', () => {
    assert.strictEqual(projectSlug('/home/user/Pro jects/my.app'), 'Pro_jects--my_app');
  }));

  tally(test('projectSlug falls back to default for empty path', () => {
    assert.strictEqual(projectSlug(''), 'default');
  }));

  tally(test('sanitizeBranchName replaces slashes with hyphens', () => {
    assert.strictEqual(sanitizeBranchName('feature/auth'), 'feature-auth');
    assert.strictEqual(sanitizeBranchName('hotfix/login/v2'), 'hotfix-login-v2');
  }));

  tally(test('sanitizeBranchName strips unsafe filename characters', () => {
    assert.strictEqual(sanitizeBranchName('release/1.0.8'), 'release-1_0_8');
    assert.strictEqual(sanitizeBranchName('fix/issue#137'), 'fix-issue_137');
  }));

  tally(test('branchStateKey prevents collisions after filename sanitization', () => {
    assert.match(branchStateKey('feature/auth'), /^feature-auth--[0-9a-f]{64}$/);
    assert.notStrictEqual(branchStateKey('feature/auth'), branchStateKey('feature-auth'));
    assert.notStrictEqual(branchStateKey('release/1.0'), branchStateKey('release-1_0'));
  }));

  tally(test('getStateDir resolves under the provided home directory', () => {
    assert.strictEqual(getStateDir('/tmp/fake-home'), path.join('/tmp/fake-home', '.egc', 'state'));
  }));

  tally(test('detectBranch returns the current branch in a git repo', () => {
    const repo = makeGitRepo('feature/auth');
    assert.strictEqual(detectBranch(repo), 'feature/auth');
  }));

  if (process.platform !== 'win32') {
    tally(test('detectBranch refuses a .git that is a symlink, even to another trusted repo (TOCTOU)', () => {
      // trustedGitPath resolves through realpathSync, so a .git symlink
      // pointing at a second, legitimate repo under the same trusted root
      // would pass that check: canonicalPath(repoA/.git) resolves to
      // repoB/.git, which is itself under a trusted root with a .git
      // segment. readHeadLine must still refuse it before ever opening a
      // file, since the link's target can be swapped again after the check
      // (the TOCTOU window a resolve-then-read sequence leaves open).
      const legitimate = makeGitRepo('feature/legit');
      const container = makeTmpDir('egc-branch-state-link-');
      const linkedGitDir = path.join(container, '.git');
      fs.symlinkSync(path.join(legitimate, '.git'), linkedGitDir, 'dir');
      assert.strictEqual(detectBranch(container), null, 'a symlinked .git is refused outright, never followed to a legitimate target');
    }));
  }

  tally(test('trustedGitPath returns the canonical path only under a trusted root with a .git segment', () => {
    const realTmp = fs.realpathSync.native(os.tmpdir());
    const under = path.join(realTmp, 'egc-trusted', '.git', 'HEAD');
    assert.strictEqual(trustedGitPath(path.join(os.tmpdir(), 'egc-trusted', 'sub', '..', '.git', 'HEAD')), under, 'resolved, normalised and canonical');
    assert.strictEqual(trustedGitPath(path.join(os.tmpdir(), 'egc-trusted', 'HEAD')), null, 'no .git segment');
    const outside = path.join(path.parse(realTmp).root, 'egc-nowhere', '.git', 'HEAD');
    assert.strictEqual(trustedGitPath(outside), null, 'outside the home and temp roots');
    assert.strictEqual(trustedGitPath(path.join(os.tmpdir(), 'egc-trusted', '..', '..', '..', '..', '..', '..', '..', '..', 'egc-nowhere', '.git')), null, 'a traversal that leaves both roots is refused');
    if (process.platform !== 'win32') {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-trusted-link-'));
      try {
        // A link at .git pointing outside both roots: the lexical path looks
        // inside the temp root, the canonical one does not.
        fs.symlinkSync(path.parse(realTmp).root, path.join(base, '.git'), 'dir');
        assert.strictEqual(trustedGitPath(path.join(base, '.git', 'HEAD')), null, 'a link leading outside the roots is refused');
        // A link that stays inside the temp root is followed and accepted.
        fs.mkdirSync(path.join(base, 'real', '.git'), { recursive: true });
        fs.symlinkSync(path.join(base, 'real'), path.join(base, 'alias'), 'dir');
        assert.strictEqual(trustedGitPath(path.join(base, 'alias', '.git', 'HEAD')), path.join(fs.realpathSync.native(base), 'real', '.git', 'HEAD'), 'a link inside the roots resolves to its canonical target');
        // A link loop cannot be canonicalised: refused.
        fs.symlinkSync(path.join(base, 'loop'), path.join(base, 'loop'));
        assert.strictEqual(trustedGitPath(path.join(base, 'loop', '.git', 'HEAD')), null, 'a link loop is refused');
        // A dangling link on the way is refused too: its target could be
        // created or moved later and redirect the read past the check.
        fs.symlinkSync(path.join(base, 'not-yet'), path.join(base, 'dangling'));
        assert.strictEqual(trustedGitPath(path.join(base, 'dangling', '.git', 'HEAD')), null, 'a dangling link on the way is refused');
        // A parent that cannot be inspected: refused, never guessed. Only
        // asserted where the mode bits actually seal the directory (not as
        // root, not in a sandbox that overrides them).
        const sealed = path.join(base, 'sealed');
        fs.mkdirSync(sealed);
        fs.chmodSync(sealed, 0o000);
        try {
          let sealedForReal = false;
          try {
            fs.readdirSync(sealed);
          } catch (error) {
            if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
            sealedForReal = true;
          }
          if (sealedForReal) {
            assert.strictEqual(trustedGitPath(path.join(sealed, 'repo', '.git', 'HEAD')), null, 'a path behind a sealed parent is refused');
          }
        } finally {
          fs.chmodSync(sealed, 0o700);
        }
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }
  }));

  tally(test('detectBranch returns null outside a git repo', () => {
    const dir = makeTmpDir('egc-branch-state-norepo-');
    assert.strictEqual(detectBranch(dir), null);
  }));

  tally(test('detectBranch returns null on detached HEAD', () => {
    const repo = makeGitRepo(null);
    git(repo, 'checkout -q --detach');
    assert.strictEqual(detectBranch(repo), null);
  }));

  tally(test('detectDetachedCommit returns the commit on detached HEAD, null on a branch or outside a repo', () => {
    const onBranch = makeGitRepo('feature/auth');
    assert.strictEqual(detectDetachedCommit(onBranch), null);

    const repo = makeGitRepo(null);
    git(repo, 'checkout -q --detach');
    const commit = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    assert.strictEqual(detectDetachedCommit(repo), commit);

    const dir = makeTmpDir('egc-branch-state-norepo-');
    assert.strictEqual(detectDetachedCommit(dir), null);

    // A truncated or otherwise corrupted HEAD (interrupted checkout, disk
    // error) must never be treated as a real commit, length in between the
    // two real object-id sizes included.
    const corrupted = makeGitRepo(null);
    git(corrupted, 'checkout -q --detach');
    fs.writeFileSync(path.join(corrupted, '.git', 'HEAD'), 'a1b2c3d4e5\n');
    assert.strictEqual(detectDetachedCommit(corrupted), null);
  }));

  tally(test('resolveHeadState reads .git/HEAD exactly once (one snapshot, not two)', () => {
    const repo = makeGitRepo(null);
    git(repo, 'checkout -q --detach');
    const originalOpen = fs.openSync;
    let headReads = 0;
    fs.openSync = function patched(target, ...rest) {
      // readHeadLine opens the raw HEAD path with O_NOFOLLOW instead of
      // handing a resolved string to readFileSync; trustedGitPath
      // canonicalizes through realpathSync.native, so on a host where the
      // temp root itself is a symlink (macOS: /tmp -> /private/tmp) the path
      // actually opened differs from the lexical one built from `repo`.
      // Matching by basename is immune to that.
      if (typeof target === 'string' && path.basename(target) === 'HEAD') headReads += 1;
      return originalOpen.call(fs, target, ...rest);
    };
    try {
      resolveHeadState(repo);
    } finally {
      fs.openSync = originalOpen;
    }
    assert.strictEqual(headReads, 1, 'detectBranch and detectDetachedCommit must not each read HEAD on their own');
  }));

  tally(test('detectDetachedCommit accepts a SHA-256 repository commit (64 hex characters)', () => {
    const repo = makeTmpDir('egc-branch-state-sha256-');
    execSync('git init -q --object-format=sha256', { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    git(repo, '-c user.email=test@test -c user.name=test -c commit.gpgsign=false commit -q -m initial --allow-empty');
    git(repo, 'checkout -q --detach');
    const commit = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    assert.strictEqual(commit.length, 64);
    assert.strictEqual(detectDetachedCommit(repo), commit);
  }));

  tally(test('resolveStateRead and resolveStateWrite isolate detached HEAD by commit, never the shared flat file', () => {
    const stateDir = makeTmpDir('egc-branch-state-detached-');
    const project = '/home/user/Projects/my-app';
    const commitA = 'a'.repeat(40);
    const commitB = 'b'.repeat(40);

    assert.strictEqual(
      resolveStateWrite(stateDir, project, null, commitA),
      detachedStateFile(stateDir, project, commitA)
    );
    assert.notStrictEqual(detachedStateFile(stateDir, project, commitA), flatStateFile(stateDir, project));
    assert.notStrictEqual(detachedStateFile(stateDir, project, commitA), detachedStateFile(stateDir, project, commitB));

    writeState(flatStateFile(stateDir, project), 'flat state, shared by every non-branch checkout');
    writeState(detachedStateFile(stateDir, project, commitA), 'detached state for commit A');

    const resolvedA = resolveStateRead(stateDir, project, null, commitA);
    assert.strictEqual(resolvedA.source, 'detached');
    assert.strictEqual(resolvedA.filePath, detachedStateFile(stateDir, project, commitA));

    const resolvedB = resolveStateRead(stateDir, project, null, commitB);
    assert.strictEqual(resolvedB.source, 'none', 'a different detached commit never inherits another one\'s state');
    assert.strictEqual(resolvedB.filePath, detachedStateFile(stateDir, project, commitB));

    const withoutDetached = resolveStateRead(stateDir, project, null);
    assert.strictEqual(withoutDetached.source, 'flat', 'omitting detachedCommit keeps reading the flat file, e.g. outside any git repo');
  }));

  tally(test('flatStateFile and branchStateFile build expected paths', () => {
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
  }));

  tally(test('colliding legacy branch names write to independent state files', () => {
    const stateDir = makeTmpDir('egc-branch-state-collision-');
    const project = '/home/user/Projects/my-app';
    const slashBranchFile = branchStateFile(stateDir, project, 'feature/auth');
    const dashBranchFile = branchStateFile(stateDir, project, 'feature-auth');

    assert.notStrictEqual(slashBranchFile, dashBranchFile);
    writeState(slashBranchFile, 'slash branch');
    writeState(dashBranchFile, 'dash branch');
    assert.match(fs.readFileSync(slashBranchFile, 'utf8'), /slash branch/);
    assert.match(fs.readFileSync(dashBranchFile, 'utf8'), /dash branch/);
  }));

  tally(test('resolveStateRead prefers the current branch file', () => {
    const stateDir = makeTmpDir('egc-branch-state-read1-');
    const project = '/home/user/Projects/my-app';
    writeState(branchStateFile(stateDir, project, 'feature/auth'), 'branch state');
    writeState(path.join(stateDir, 'Projects--my-app', 'main.md'), 'main state');
    writeState(flatStateFile(stateDir, project), 'flat state');

    const resolved = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(resolved.source, 'branch');
    assert.strictEqual(resolved.filePath, branchStateFile(stateDir, project, 'feature/auth'));
  }));

  tally(test('resolveStateRead falls back to main.md when branch file is missing', () => {
    const stateDir = makeTmpDir('egc-branch-state-read2-');
    const project = '/home/user/Projects/my-app';
    writeState(path.join(stateDir, 'Projects--my-app', 'main.md'), 'main state');

    const resolved = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(resolved.source, 'default-branch');
    assert.strictEqual(resolved.filePath, path.join(stateDir, 'Projects--my-app', 'main.md'));
  }));

  tally(test('resolveStateRead migrates safely from legacy branch filenames', () => {
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
  }));

  tally(test('resolveStateRead falls back to the legacy flat file', () => {
    const stateDir = makeTmpDir('egc-branch-state-read3-');
    const project = '/home/user/Projects/my-app';
    writeState(flatStateFile(stateDir, project), 'flat state');

    const resolved = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(resolved.source, 'flat');
    assert.strictEqual(resolved.filePath, flatStateFile(stateDir, project));
  }));

  tally(test('resolveStateRead reads the flat file when there is no branch', () => {
    const stateDir = makeTmpDir('egc-branch-state-read4-');
    const project = '/home/user/Projects/my-app';
    writeState(flatStateFile(stateDir, project), 'flat state');

    const resolved = resolveStateRead(stateDir, project, null);
    assert.strictEqual(resolved.source, 'flat');
    assert.strictEqual(resolved.filePath, flatStateFile(stateDir, project));
  }));

  tally(test('resolveStateRead reports none when no state exists', () => {
    const stateDir = makeTmpDir('egc-branch-state-read5-');
    const project = '/home/user/Projects/my-app';

    const withBranch = resolveStateRead(stateDir, project, 'feature/auth');
    assert.strictEqual(withBranch.source, 'none');
    assert.strictEqual(withBranch.filePath, branchStateFile(stateDir, project, 'feature/auth'));

    const withoutBranch = resolveStateRead(stateDir, project, null);
    assert.strictEqual(withoutBranch.source, 'none');
    assert.strictEqual(withoutBranch.filePath, flatStateFile(stateDir, project));
  }));

  tally(test('resolveStateWrite targets the branch file when a branch exists', () => {
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
  }));

  tally(test('collectMemoryState reports the active branch state', () => {
    const home = makeTmpDir('egc-branch-state-home1-');
    const repo = makeGitRepo('feature/auth');
    const stateFile = branchStateFile(getStateDir(home), repo, 'feature/auth');
    writeState(stateFile, 'branch state');

    const result = collectMemoryState(repo, home);
    assert.strictEqual(result.branch, 'feature/auth');
    assert.strictEqual(result.source, 'branch');
    assert.strictEqual(result.stateFile, stateFile);
    assert.strictEqual(result.slug, projectSlug(repo));
  }));

  tally(test('collectMemoryState reports flat fallback and missing state', () => {
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
  }));

  tally(test('egc-memory-load hook injects the branch state', () => {
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
  }));

  tally(test('egc-memory-load hook injects the detached-commit state, never the flat state', () => {
    const home = makeTmpDir('egc-branch-state-home4b-');
    const repo = makeGitRepo(null);
    git(repo, 'checkout -q --detach');
    const commit = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    writeState(detachedStateFile(getStateDir(home), repo, commit), 'DETACHED_MARKER_137');
    writeState(flatStateFile(getStateDir(home), repo), 'FLAT_MARKER_137');

    const result = spawnSync('node', [HOOK_PATH], {
      input: '{}',
      encoding: 'utf8',
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, PWD: repo }),
      cwd: repo,
    });

    assert.strictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.ok(output.promptForAssistant.includes('DETACHED_MARKER_137'));
    assert.ok(!output.promptForAssistant.includes('FLAT_MARKER_137'));
  }));

  tally(test('egc-memory-load hook falls back to the flat state', () => {
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
  }));

  tally(test('egc-memory-load hook passes input through when no state exists', () => {
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
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
