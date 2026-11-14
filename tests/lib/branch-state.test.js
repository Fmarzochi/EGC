'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const {
  getStateDir,
  projectSlug,
  normalizeRemoteUrl,
  detectOriginRemote,
  projectIdentity,
  projectKey,
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
const { outsideHomeAndTemp, removeOutside } = require('../fixtures/outside-home-dir');

const HOOK_PATH = path.join(__dirname, '../../scripts/hooks/egc-memory-load.js');
const stateCrypto = require('../../scripts/lib/state-crypto');

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

// A repository with an origin remote, the shape the identity tests need:
// the same remote under two different paths is the same project.
function makeRemoteRepo(branch, remoteUrl) {
  const repo = makeGitRepo(null);
  git(repo, `checkout -q -B ${branch}`);
  git(repo, `remote add origin ${remoteUrl}`);
  return repo;
}

const REMOTE_HTTPS = 'https://github.com/Owner/Repo.git';
const REMOTE_SSH = 'git@github.com:Owner/Repo.git';
const REMOTE_IDENTITY = 'github.com/Owner/Repo';

function runIdentityTests(tally) {
  tally(test('normalizeRemoteUrl folds the forms of one repository into one identity', () => {
    assert.strictEqual(normalizeRemoteUrl(REMOTE_HTTPS), REMOTE_IDENTITY);
    assert.strictEqual(normalizeRemoteUrl('https://user:token@GitHub.com/Owner/Repo/'), REMOTE_IDENTITY, 'credentials, host case and a trailing slash are dropped');
    assert.strictEqual(normalizeRemoteUrl(REMOTE_SSH), REMOTE_IDENTITY, 'the scp-like form of ssh');
    assert.strictEqual(normalizeRemoteUrl('ssh://git@github.com:22/Owner/Repo.git'), REMOTE_IDENTITY, 'the default ssh port is not part of the identity');
    assert.strictEqual(normalizeRemoteUrl('ssh://git@host.example:2222/srv/x.git'), 'host.example:2222/srv/x', 'another port is');
    assert.strictEqual(normalizeRemoteUrl('felipe@192.168.1.111:/srv/egc/memory.git'), '192.168.1.111/srv/egc/memory', 'an absolute path on a host of the LAN');
    assert.strictEqual(normalizeRemoteUrl('file:///srv/git/repo.git'), 'file/srv/git/repo');
    assert.strictEqual(normalizeRemoteUrl('/srv/git/repo.git'), 'file/srv/git/repo', 'a local path is a local identity');
    assert.strictEqual(normalizeRemoteUrl('C:\\repos\\x.git'), 'file/C:/repos/x', 'a Windows drive is not an ssh host');
    assert.notStrictEqual(normalizeRemoteUrl('https://github.com/owner/repo'), REMOTE_IDENTITY, 'owner and name are kept as written');
    assert.strictEqual(normalizeRemoteUrl(''), null);
    assert.strictEqual(normalizeRemoteUrl('   '), null);
    assert.strictEqual(normalizeRemoteUrl('https://'), null, 'a URL without a host names nothing');
  }));

  tally(test('normalizeRemoteUrl folds the rarer forms too: bracketed hosts, git and file schemes, drive letters, relative paths', () => {
    assert.strictEqual(normalizeRemoteUrl('git@[2001:db8::1]:owner/repo.git'), normalizeRemoteUrl('ssh://git@[2001:db8::1]/owner/repo.git'), 'an IPv6 host in the scp-like form is not split at its colons');
    assert.strictEqual(normalizeRemoteUrl('git@[2001:db8::1]:owner/repo.git'), '[2001:db8::1]/owner/repo');
    assert.strictEqual(normalizeRemoteUrl('git@[example.com:2222]:owner/repo.git'), 'example.com:2222/owner/repo', 'a bracketed host and port in the scp-like form is the ssh URL with that port');
    assert.strictEqual(normalizeRemoteUrl('git://example.com:9418/owner/repo.git'), 'example.com/owner/repo', 'the default port of the git protocol is not part of the identity');
    assert.strictEqual(normalizeRemoteUrl('file://server/share/repo.git'), 'file/server/share/repo', 'the host of a file URL is part of the identity');
    assert.strictEqual(normalizeRemoteUrl('\\\\server\\share\\repo.git'), 'file/server/share/repo', 'and the UNC form of the same share agrees');
    assert.strictEqual(normalizeRemoteUrl('c:\\repos\\x.git'), 'file/C:/repos/x', 'a drive letter is one letter whatever its case');
    assert.strictEqual(normalizeRemoteUrl('file:///c:/repos/x.git'), 'file/C:/repos/x');
    assert.strictEqual(normalizeRemoteUrl('../bare.git', '/work/a/app'), normalizeRemoteUrl(path.resolve('/work/a/app', '../bare.git')), 'a relative path is resolved against the checkout, so two repositories with the same relative remote are not one');
    assert.notStrictEqual(normalizeRemoteUrl('../bare.git', '/work/a/app'), normalizeRemoteUrl('../bare.git', '/work/b/tool'));
    assert.strictEqual(normalizeRemoteUrl('/srv/git/repo.git', '/work/a/app'), 'file/srv/git/repo', 'an absolute path ignores the checkout');
    assert.strictEqual(normalizeRemoteUrl('\\\\server\\share\\repo.git', '/work/a/app'), 'file/server/share/repo', 'a UNC path is absolute on every platform');
    assert.strictEqual(normalizeRemoteUrl('user@corp.com@github.com:org/repo.git'), 'github.com/org/repo', 'the host starts after the last @ before the colon');
    assert.strictEqual(normalizeRemoteUrl('git@[github.com:22]:org/repo.git'), 'github.com/org/repo', 'the default ssh port between brackets is dropped as in the URL form');
    assert.strictEqual(normalizeRemoteUrl('git@[github.com]:org/repo.git'), 'github.com/org/repo', 'brackets around a plain host are dropped');
    const relativeRemote = makeGitRepo('main');
    git(relativeRemote, 'remote add origin ../bare.git');
    const canonicalCheckout = fs.realpathSync.native(relativeRemote);
    assert.strictEqual(projectIdentity(relativeRemote).remote, normalizeRemoteUrl(path.resolve(canonicalCheckout, '../bare.git')), 'the identity of a checkout resolves its relative remote against the canonical path of the checkout (the temp root is a link on macOS)');
    const subdirectory = path.join(relativeRemote, 'src', 'deep');
    fs.mkdirSync(subdirectory, { recursive: true });
    assert.strictEqual(projectIdentity(subdirectory).remote, projectIdentity(relativeRemote).remote, 'and against the root of the checkout when asked from a subdirectory of it');
    if (process.platform !== 'win32') {
      const alias = path.join(makeTmpDir('egc-branch-state-alias-'), 'alias');
      fs.symlinkSync(relativeRemote, alias, 'dir');
      assert.strictEqual(projectIdentity(alias).remote, projectIdentity(relativeRemote).remote, 'and against the canonical root when the checkout is reached through a link');
    }
  }));

  tally(test('originUrlFromConfig reads what git reads: comments and assignments after a header, the dotted form, continuations, partial quotes and escapes', () => {
    const { originUrlFromConfig } = require('../../scripts/lib/branch-state');
    assert.strictEqual(originUrlFromConfig('[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[remote "upstream"] # mirror\n\turl = https://github.com/other/fork.git\n'), null, 'a header followed by a comment still closes the section before it');
    assert.strictEqual(originUrlFromConfig('[remote "origin"] url = https://github.com/Owner/Repo.git\n'), 'https://github.com/Owner/Repo.git', 'an assignment on the line of the header belongs to that section');
    assert.strictEqual(originUrlFromConfig('[remote.origin]\n\turl = https://github.com/Owner/Repo.git\n'), 'https://github.com/Owner/Repo.git', 'the deprecated dotted form');
    assert.strictEqual(originUrlFromConfig('[Remote.Origin]\n\turl = https://github.com/Owner/Repo.git\n'), 'https://github.com/Owner/Repo.git', 'whose subsection compares case-insensitively, as git does');
    assert.strictEqual(originUrlFromConfig('[remote "origin"]\n\turl = \\\n\t\thttps://github.com/Owner/Repo.git\n'), 'https://github.com/Owner/Repo.git', 'a backslash at the end of a line continues the value');
    assert.strictEqual(originUrlFromConfig('[remote "origin"]\n\turl = "https://github.com/"Owner/Repo.git\n'), 'https://github.com/Owner/Repo.git', 'quotes may open and close anywhere in a value');
    assert.strictEqual(originUrlFromConfig('[remote "origin"]\n\turl = C:\\\\Users\\\\me\\\\repo.git\n'), 'C:\\Users\\me\\repo.git', 'an escaped backslash is one backslash');
    assert.strictEqual(originUrlFromConfig('[remote "origin"]\r\n\turl = https://github.com/Owner/Repo.git\r\n'), 'https://github.com/Owner/Repo.git', 'CRLF');
    assert.strictEqual(originUrlFromConfig('[remote "ori\\"gin"]\n\turl = https://github.com/Owner/Repo.git\n'), null, 'an escaped quote in the subsection is part of its name');
    assert.strictEqual(originUrlFromConfig('[remote "origin"]\n\t# local mirror in C:\\repos\\origin\\\n\turl = https://github.com/Owner/Repo.git\n'), 'https://github.com/Owner/Repo.git', 'a backslash at the end of a comment continues nothing');
    assert.strictEqual(originUrlFromConfig('[core] [remote "origin"]\n\turl = https://github.com/Owner/Repo.git\n'), 'https://github.com/Owner/Repo.git', 'the last of several headers on one line is the section that opens');
    assert.strictEqual(originUrlFromConfig('[remote "origin"] [remote "upstream"]\n\turl = https://github.com/other/fork.git\n'), null);
  }));

  tally(test('legacyBranchStateFile points at the directory the versions before the identity wrote, and projectReadNames lists the key before it', () => {
    const { projectReadNames } = require('../../scripts/lib/branch-state');
    const stateDir = makeTmpDir('egc-branch-state-legacy2-');
    const repo = makeRemoteRepo('feature/auth', REMOTE_HTTPS);
    assert.strictEqual(legacyBranchStateFile(stateDir, repo, 'feature/auth'), path.join(stateDir, projectSlug(repo), 'feature-auth.md'));
    assert.deepStrictEqual(projectReadNames(repo), [projectKey(repo), projectSlug(repo)]);
    const plain = makeTmpDir('egc-branch-state-plain2-');
    assert.deepStrictEqual(projectReadNames(plain), [projectSlug(plain)]);
  }));

  tally(test('projectKey names a project by its origin remote and falls back to the path slug', () => {
    const viaHttps = makeRemoteRepo('main', REMOTE_HTTPS);
    const viaSsh = makeRemoteRepo('main', REMOTE_SSH);
    assert.notStrictEqual(viaHttps, viaSsh);
    assert.strictEqual(projectKey(viaHttps), projectKey(viaSsh), 'two checkouts of one repository have one key');
    assert.match(projectKey(viaHttps), /^Repo--[0-9a-f]{64}$/, 'a readable name bound to the hash of the identity');
    assert.deepStrictEqual(projectIdentity(viaHttps), { key: projectKey(viaHttps), kind: 'remote', remote: REMOTE_IDENTITY });
    assert.ok(!projectKey(viaHttps).includes('github'), 'the host is not in the key');
    assert.ok(!projectKey(viaHttps).includes('Owner'), 'the owner is not in the key');
    assert.ok(!projectKey(viaHttps).includes(path.basename(viaHttps)), 'the local path is not in the key');

    const plain = makeTmpDir('egc-branch-state-plain-');
    assert.strictEqual(projectKey(plain), projectSlug(plain), 'outside a repository the slug of the path is the key, as before');
    assert.strictEqual(projectIdentity(plain).kind, 'path');
    const noRemote = makeGitRepo('main');
    assert.strictEqual(projectKey(noRemote), projectSlug(noRemote), 'a repository without origin keeps the slug of the path');
    assert.deepStrictEqual(projectIdentity(noRemote), { key: projectSlug(noRemote), kind: 'path', remote: null });
  }));

  tally(test('detectOriginRemote reads the url of origin from the repository config, worktrees included', () => {
    const repo = makeRemoteRepo('main', REMOTE_HTTPS);
    assert.strictEqual(detectOriginRemote(repo), REMOTE_HTTPS);
    const worktree = path.join(makeTmpDir('egc-branch-state-worktree-'), 'wt');
    git(repo, `worktree add -q "${worktree}" -b wt`);
    assert.strictEqual(detectOriginRemote(worktree), REMOTE_HTTPS, 'a worktree reads the config of the common directory');
    assert.strictEqual(projectKey(worktree), projectKey(repo), 'a worktree is the same project as its repository');
    assert.strictEqual(detectOriginRemote(makeGitRepo('main')), null);
    assert.strictEqual(detectOriginRemote(makeTmpDir('egc-branch-state-norepo-')), null);
  }));

  tally(test('resolveStateRead keeps reading the documents keyed by the path slug after the upgrade, and writes under the remote key', () => {
    const stateDir = makeTmpDir('egc-branch-state-upgrade-');
    const repo = makeRemoteRepo('feature/auth', REMOTE_HTTPS);
    const slugDir = path.join(stateDir, projectSlug(repo));
    const keyDir = path.join(stateDir, projectKey(repo));
    assert.notStrictEqual(slugDir, keyDir);

    const legacyOwn = path.join(slugDir, `${branchStateKey('feature/auth')}.md`);
    writeState(legacyOwn, 'written by the version before the identity');
    const fromLegacy = resolveStateRead(stateDir, repo, 'feature/auth');
    assert.strictEqual(fromLegacy.filePath, legacyOwn, 'a machine with path-keyed documents keeps reading them');
    assert.strictEqual(fromLegacy.source, 'branch');

    const target = resolveStateWrite(stateDir, repo, 'feature/auth');
    assert.strictEqual(target, path.join(keyDir, `${branchStateKey('feature/auth')}.md`), 'every write goes under the remote key');
    assert.strictEqual(branchStateFile(stateDir, repo, 'feature/auth'), target);
    writeState(target, 'written by this version');
    assert.strictEqual(resolveStateRead(stateDir, repo, 'feature/auth').filePath, target, 'once written, the keyed document shadows the legacy one');

    writeState(path.join(slugDir, 'main.md'), 'legacy default branch');
    const legacyDefault = resolveStateRead(stateDir, repo, 'another');
    assert.strictEqual(legacyDefault.filePath, path.join(slugDir, 'main.md'));
    assert.strictEqual(legacyDefault.source, 'default-branch');
    writeState(branchStateFile(stateDir, repo, 'main'), 'keyed default branch');
    assert.strictEqual(resolveStateRead(stateDir, repo, 'another').filePath, branchStateFile(stateDir, repo, 'main'), 'the keyed default branch wins over the legacy one');

    const commit = 'c'.repeat(40);
    const legacyDetached = path.join(slugDir, `detached--${commit}.md`);
    writeState(legacyDetached, 'legacy detached');
    assert.strictEqual(resolveStateRead(stateDir, repo, null, commit).filePath, legacyDetached);
    assert.strictEqual(resolveStateWrite(stateDir, repo, null, commit), path.join(keyDir, `detached--${commit}.md`));

    const flatRepo = makeRemoteRepo('main', 'https://example.com/Flat/Only.git');
    writeState(path.join(stateDir, `${projectSlug(flatRepo)}.md`), 'legacy flat');
    const flat = resolveStateRead(stateDir, flatRepo, 'main');
    assert.strictEqual(flat.source, 'flat');
    assert.strictEqual(flat.filePath, path.join(stateDir, `${projectSlug(flatRepo)}.md`));
    assert.strictEqual(flatStateFile(stateDir, flatRepo), path.join(stateDir, `${projectKey(flatRepo)}.md`));

    const none = resolveStateRead(stateDir, makeRemoteRepo('main', 'https://example.com/No/State.git'), 'main');
    assert.strictEqual(none.source, 'none');
    assert.ok(none.filePath.startsWith(path.join(stateDir, 'State--')), 'a project with no state yet is created under its key');
  }));

  tally(test('two checkouts of one repository at different paths read and write one state file', () => {
    const stateDir = makeTmpDir('egc-branch-state-shared-');
    const here = makeRemoteRepo('main', REMOTE_HTTPS);
    const there = makeRemoteRepo('main', REMOTE_SSH);
    const written = resolveStateWrite(stateDir, here, 'main');
    writeState(written, 'decided on the first machine');
    const read = resolveStateRead(stateDir, there, 'main');
    assert.strictEqual(read.source, 'branch');
    assert.strictEqual(read.filePath, written);
    assert.strictEqual(resolveStateWrite(stateDir, there, 'main'), written);
  }));

  tally(test('egc-memory-load hook injects the state keyed by the remote', () => {
    const home = makeTmpDir('egc-branch-state-home7-');
    const repo = makeRemoteRepo('feature/auth', REMOTE_HTTPS);
    const stateFile = branchStateFile(getStateDir(home), repo, 'feature/auth');
    assert.ok(path.basename(path.dirname(stateFile)).startsWith('Repo--'));
    writeState(stateFile, 'REMOTE_KEY_MARKER_2063');

    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: '{}',
      encoding: 'utf8',
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, PWD: repo }),
      cwd: repo,
    });

    assert.strictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.ok(output.promptForAssistant.includes('REMOTE_KEY_MARKER_2063'));
  }));

  tally(test('egc-memory-load hook decrypts an encrypted state file, drops its retired line and never injects ciphertext (#2055)', () => {
    const home = makeTmpDir('egc-branch-state-home8-');
    const repo = makeRemoteRepo('feature/auth', REMOTE_HTTPS);
    const stateFile = branchStateFile(getStateDir(home), repo, 'feature/auth');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const plaintext = `# Project State\nupdated: 2026-11-07T10:00:00.000Z\nretired: ${'a'.repeat(12)}@2026-11-07T10:00:00.000Z\n\n## Context\nENCRYPTED_MARKER_2055\n`;
    fs.writeFileSync(stateFile, stateCrypto.encryptStateBuffer(plaintext, path.join(home, '.egc', 'encryption.key')));

    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: '{}',
      encoding: 'utf8',
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, PWD: repo }),
      cwd: repo,
    });

    assert.strictEqual(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.ok(output.promptForAssistant.includes('ENCRYPTED_MARKER_2055'), 'the decrypted state is injected');
    assert.ok(!output.promptForAssistant.includes('EGC1:'), 'no ciphertext reaches the session');
    assert.ok(!output.promptForAssistant.includes('retired:'), 'and no retired line');
  }));
}

function runTests() {
  console.log('\n=== Testing branch-state.js ===\n');

  let passed = 0;
  let failed = 0;
  const tally = ok => (ok ? passed++ : failed++);

  runIdentityTests(tally);

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

  tally(test('a checkout outside the home and the temp directory is keyed by its remote and its branch, never one under a system directory (#2109)', () => {
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
    // A system directory is never trusted on the account of a project or a
    // pointer, and the filesystem root holds no repository.
    const system = process.platform === 'win32' ? path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'egc-x') : '/etc/egc-x';
    assert.strictEqual(trustedGitPath(path.join(system, '.git', 'HEAD'), { project: system }), null, 'a .git under a system directory');
    assert.strictEqual(trustedGitPath(path.join(system, '.git', 'HEAD'), { followed: true }), null, 'even when a trusted file named it');
    const root = path.parse(os.homedir()).root;
    assert.strictEqual(trustedGitPath(path.join(root, '.git', 'HEAD'), { project: root }), null, 'a .git at the filesystem root');
    assert.strictEqual(trustedGitPath(path.join(root, '.git', 'HEAD'), { followed: true }), null, 'even when a trusted file named the root');
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

    const result = spawnSync(process.execPath, [HOOK_PATH], {
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
