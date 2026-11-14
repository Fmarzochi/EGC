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
const { outsideHomeAndTemp, removeOutside } = require('../fixtures/outside-home-dir');

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

function makeRemoteRepo(branch, remoteUrl) {
  const repo = makeGitRepo(null);
  execSync(`git checkout -q -B ${branch}`, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  execSync(`git remote add origin ${remoteUrl}`, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  return repo;
}

const REMOTE_HTTPS = 'https://github.com/Owner/Repo.git';
const REMOTE_SSH = 'git@github.com:Owner/Repo.git';

let passed = 0;
let failed = 0;

function run(name, fn) {
  if (test(name, fn)) passed++; else failed++;
}

// A checkout outside the home and the temp directory (#2109): its own
// repository is read, a system directory and the filesystem root never are,
// on the build and on the mirror the hooks use alike.
function runOutsideHomeTest(api) {
  const { detectBranch, detectOriginRemote, projectIdentity, trustedGitPath } = api;
  run('a checkout outside the home and the temp directory is keyed by its remote and its branch, never one under a system directory (#2109)', () => {
    const outside = outsideHomeAndTemp();
    if (outside) {
      try {
        const repo = path.join(outside, 'repo');
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/egc-field/example.git\n');
        assert.strictEqual(detectBranch(repo), 'main', 'the branch of a checkout outside the home and the temp directory');
        assert.strictEqual(detectOriginRemote(repo), 'https://github.com/egc-field/example.git', 'its origin');
        assert.strictEqual(projectIdentity(repo).kind, 'remote');
        const sub = path.join(repo, 'packages', 'app');
        fs.mkdirSync(sub, { recursive: true });
        assert.deepStrictEqual(projectIdentity(sub), projectIdentity(repo), 'a subdirectory of the checkout is the same project');
        const hooks = require('../../scripts/lib/branch-state');
        assert.deepStrictEqual(hooks.projectIdentity(sub), projectIdentity(repo), 'the hooks agree');
        const head = path.join(repo, '.git', 'HEAD');
        assert.strictEqual(trustedGitPath(head, { project: repo }), fs.realpathSync.native(head));
        assert.strictEqual(trustedGitPath(head), null, 'without a project the roots are the home and the temp directory, as before');
        const sibling = path.join(outside, 'sibling');
        fs.mkdirSync(sibling);
        assert.strictEqual(trustedGitPath(head, { project: sibling }), null, 'the repository of another project is not trusted on its account');
        assert.strictEqual(detectBranch(sibling), null);
      } finally {
        removeOutside(outside);
      }
    } else if (process.env.EGC_REQUIRE_OUTSIDE_DIR) {
      assert.fail('no writable directory outside the home and the temp directory, and EGC_REQUIRE_OUTSIDE_DIR asks for one');
    } else {
      console.log('    (no writable directory outside the home and the temp directory on this machine)');
    }
    const system = process.platform === 'win32' ? path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'egc-x') : '/etc/egc-x';
    assert.strictEqual(trustedGitPath(path.join(system, '.git', 'HEAD'), { project: system }), null, 'a .git under a system directory');
    assert.strictEqual(trustedGitPath(path.join(system, '.git', 'HEAD'), { followed: true }), null, 'even when a trusted file named it');
    const root = path.parse(os.homedir()).root;
    assert.strictEqual(trustedGitPath(path.join(root, '.git', 'HEAD'), { project: root }), null, 'a .git at the filesystem root');
    assert.strictEqual(trustedGitPath(path.join(root, '.git', 'HEAD'), { followed: true }), null, 'even when a trusted file named the root');
  });
}

// The identity of a project by its origin remote (#2063), checked against
// the build and against the mirror the hooks use.
function runIdentityTests(api) {
  const { projectSlug, branchStateKey, detectBranch, normalizeRemoteUrl, originUrlFromConfig, detectOriginRemote, projectIdentity, projectKey, resolveStateRead, resolveStateWrite } = api;

  run('normalizeRemoteUrl and projectKey agree with scripts/lib/branch-state.js, so the hooks and the server name a project the same way (#2063)', () => {
    const mirror = require('../../scripts/lib/branch-state');
    const forms = [REMOTE_HTTPS, REMOTE_SSH, 'https://user:token@GitHub.com/Owner/Repo/', 'ssh://git@github.com:22/Owner/Repo.git', 'ssh://git@host.example:2222/srv/x.git', 'felipe@192.168.1.111:/srv/egc/memory.git', 'file:///srv/git/repo.git', '/srv/git/repo.git', 'C:\\repos\\x.git', 'c:\\repos\\x.git', 'git@[2001:db8::1]:owner/repo.git', 'git@[example.com:2222]:owner/repo.git', 'git@[github.com:22]:org/repo.git', 'git@[github.com]:org/repo.git', 'user@corp.com@github.com:org/repo.git', 'git://example.com:9418/owner/repo.git', 'file://server/share/repo.git', '\\\\server\\share\\repo.git', '', 'https://'];
    for (const url of forms) {
      assert.strictEqual(normalizeRemoteUrl(url), mirror.normalizeRemoteUrl(url), `the two implementations agree on ${JSON.stringify(url)}`);
    }
    assert.strictEqual(normalizeRemoteUrl('../bare.git', '/work/a/app'), mirror.normalizeRemoteUrl('../bare.git', '/work/a/app'), 'and on a relative path resolved against the checkout');
    const configs = ['[remote "origin"] url = https://github.com/Owner/Repo.git\n', '[remote.origin]\n\turl = https://github.com/Owner/Repo.git\n', '[remote "origin"]\n\turl = \\\n\t\thttps://github.com/Owner/Repo.git\n', '[remote "origin"]\n\turl = "https://github.com/"Owner/Repo.git # c\n', '[remote "origin"]\n\tfetch = x\n[remote "upstream"] ; m\n\turl = https://github.com/other/fork.git\n', '[remote "origin"]\n\t# mirror in C:\\repos\\origin\\\n\turl = https://github.com/Owner/Repo.git\n', '[core] [remote "origin"]\n\turl = https://github.com/Owner/Repo.git\n'];
    for (const config of configs) {
      assert.strictEqual(originUrlFromConfig(config), mirror.originUrlFromConfig(config), `the two parsers agree on ${JSON.stringify(config)}`);
    }
    assert.strictEqual(originUrlFromConfig(configs[4]), null);
    assert.strictEqual(normalizeRemoteUrl('https://user:token@GitHub.com/Owner/Repo/'), 'github.com/Owner/Repo');
    assert.strictEqual(normalizeRemoteUrl(REMOTE_SSH), 'github.com/Owner/Repo');
    assert.strictEqual(normalizeRemoteUrl('https://'), null);

    const repo = makeRemoteRepo('main', REMOTE_HTTPS);
    assert.strictEqual(detectOriginRemote(repo), REMOTE_HTTPS);
    assert.strictEqual(projectKey(repo), mirror.projectKey(repo));
    assert.match(projectKey(repo), /^Repo--[0-9a-f]{64}$/);
    assert.deepStrictEqual(projectIdentity(repo), { key: projectKey(repo), kind: 'remote', remote: 'github.com/Owner/Repo' });
    const plain = makeTmpDir('egc-memory-plain-');
    assert.deepStrictEqual(projectIdentity(plain), { key: projectSlug(plain), kind: 'path', remote: null });
    assert.strictEqual(detectOriginRemote(makeGitRepo('main')), null, 'a repository without origin has no remote identity');
  });

  run('originUrlFromConfig reads the first url of origin the way git does', () => {
    assert.strictEqual(originUrlFromConfig('[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/Owner/Repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'), 'https://github.com/Owner/Repo.git');
    assert.strictEqual(originUrlFromConfig('[Remote "origin"]\n\turl = "git@github.com:Owner/Repo.git" ; a comment\n'), 'git@github.com:Owner/Repo.git', 'the section name is case-insensitive, a quoted value is taken whole, a comment after it is not');
    assert.strictEqual(originUrlFromConfig('[remote "origin"]\n\turl = https://github.com/Owner/Repo.git # a comment\n'), 'https://github.com/Owner/Repo.git');
    assert.strictEqual(originUrlFromConfig('[remote "upstream"]\n\turl = https://github.com/Other/Repo.git\n'), null, 'another remote is not origin');
    assert.strictEqual(originUrlFromConfig('[remote "origin"]\n\tpushurl = https://github.com/Owner/Repo.git\n'), null, 'a push url alone names no identity');
    assert.strictEqual(originUrlFromConfig('[remote "origin"]\n\turlx = https://github.com/Owner/Repo.git\n'), null, 'a key that only starts with url is another key');
    assert.strictEqual(originUrlFromConfig(''), null);
  });

  run('two checkouts of one repository share the state, documents keyed by the path are still read, and a worktree is the same project (#2063)', () => {
    const stateDir = makeTmpDir('egc-memory-identity-');
    const here = makeRemoteRepo('feature/auth', REMOTE_HTTPS);
    const there = makeRemoteRepo('feature/auth', REMOTE_SSH);
    const legacy = path.join(stateDir, projectSlug(here), `${branchStateKey('feature/auth')}.md`);
    writeState(legacy, 'legacy');
    assert.strictEqual(resolveStateRead(stateDir, here, 'feature/auth').filePath, legacy, 'the document of the version before the identity is read where it is');
    const target = resolveStateWrite(stateDir, here, 'feature/auth');
    assert.notStrictEqual(target, legacy);
    assert.strictEqual(path.basename(path.dirname(target)), projectKey(here));
    writeState(target, 'shared');
    assert.strictEqual(resolveStateRead(stateDir, here, 'feature/auth').filePath, target, 'the keyed document shadows the legacy one');
    assert.strictEqual(resolveStateRead(stateDir, there, 'feature/auth').filePath, target, 'the other checkout reads the same document');
    assert.strictEqual(resolveStateWrite(stateDir, there, 'feature/auth'), target);

    const worktree = path.join(makeTmpDir('egc-memory-worktree-'), 'wt');
    execSync(`git worktree add -q "${worktree}" -b wt`, { cwd: here, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.strictEqual(detectOriginRemote(worktree), REMOTE_HTTPS, 'a worktree reads the config of the common directory');
    assert.strictEqual(projectKey(worktree), projectKey(here));
  });

  run('a gitdir pointer or a commondir that leads to a symlinked directory is refused, as the hooks refuse it', () => {
    if (process.platform === 'win32') return;
    const victim = makeRemoteRepo('main', REMOTE_HTTPS);
    const container = makeTmpDir('egc-memory-pointer-');
    const link = path.join(container, 'link-to-victim-git');
    fs.symlinkSync(path.join(victim, '.git'), link, 'dir');
    const pointed = path.join(container, 'pointed');
    fs.mkdirSync(pointed);
    fs.writeFileSync(path.join(pointed, '.git'), `gitdir: ${link}\n`);
    assert.strictEqual(detectOriginRemote(pointed), null, 'a pointer to a linked directory is not followed');
    assert.strictEqual(detectBranch(pointed), null);
    assert.strictEqual(require('../../scripts/lib/branch-state').detectOriginRemote(pointed), null, 'the hooks agree');

    const worktree = path.join(container, 'wt');
    execSync(`git worktree add -q "${worktree}" -b linked`, { cwd: victim, stdio: ['ignore', 'pipe', 'pipe'] });
    const worktreeGitDir = path.join(victim, '.git', 'worktrees', 'wt');
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), `${link}\n`);
    assert.strictEqual(detectOriginRemote(worktree), null, 'a commondir that names a linked directory is not followed');
    assert.strictEqual(require('../../scripts/lib/branch-state').detectOriginRemote(worktree), null, 'the hooks agree');
  });
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

  runOutsideHomeTest(api);

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

  runIdentityTests(api);

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
