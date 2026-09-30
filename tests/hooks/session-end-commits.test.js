/**
 * Tests for the commit list scripts/hooks/session-end.js keeps in the session
 * header: the commits the person made in the repository since the session
 * started, so the next session knows what was delivered without asking git.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const hookScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'session-end.js');
// The hook names the session file after the transcript UUID's last 8 chars.
const TRANSCRIPT = path.join(os.tmpdir(), 'egc-n33-missing', '12345678-1234-1234-1234-1234567890ab.jsonl');
const SHORT_ID = '567890ab';
const ME = { name: 'Session Person', email: 'person@example.com' };
const OTHER = { name: 'Someone Else', email: 'other@example.com' };
// An empty global config keeps the machine's own git settings (signing,
// hooks paths) out of these repositories on every platform.
const GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-n33-gitconfig-'));
const EMPTY_GIT_CONFIG = path.join(GIT_HOME, '.gitconfig');
fs.writeFileSync(EMPTY_GIT_CONFIG, '');
const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: '1' };
// Fixed git locations before a PATH lookup, as the hook itself does.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

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

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function git(repo, args, author = ME, date = '2026-01-15T11:00:00', committedAt = date) {
  return execFileSync(GIT_BIN, args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...GIT_ISOLATION,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: committedAt,
    },
  }).trim();
}

function commit(repo, message, author, date, committedAt = date) {
  fs.writeFileSync(path.join(repo, `${message.replaceAll(' ', '-')}.txt`), message);
  git(repo, ['add', '-A'], author, date, committedAt);
  git(repo, ['commit', '-q', '-m', message], author, date, committedAt);
  return git(repo, ['rev-parse', '--short', 'HEAD'], author, date, committedAt);
}

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-n33-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-n33-repo-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', ME.name]);
  git(repo, ['config', 'user.email', ME.email]);
  const sessionsDir = path.join(home, '.egc', 'session-data');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, `${today()}-${SHORT_ID}-session.tmp`);
  fs.writeFileSync(sessionFile, [
    '# Session: 2026-01-15',
    '**Date:** 2026-01-15',
    '**Started:** 10:00',
    '**Last Updated:** 10:00',
    '**Project:** n33',
    '**Branch:** main',
    `**Worktree:** ${repo}`,
    '',
    '---',
    '## Current State',
    '',
  ].join('\n'));
  return { home, repo, sessionFile };
}

function runHook(home, cwd, extraEnv = {}) {
  const result = spawnSync(process.execPath, [hookScript], {
    cwd,
    input: JSON.stringify({ transcript_path: TRANSCRIPT }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ...GIT_ISOLATION, ...extraEnv },
    timeout: 30000,
  });
  assert.strictEqual(result.status, 0, result.stderr);
}

// A configured email outside any repository, the way a real machine has one
// in its global config, so the hook reaches git log and it fails there.
const EMAIL_FROM_ENV = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.email', GIT_CONFIG_VALUE_0: ME.email };

function headerOf(sessionFile) {
  return fs.readFileSync(sessionFile, 'utf8').split('\n---\n')[0];
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

function runTests() {
  console.log('\n=== Testing session-end commit list ===\n');

  const results = [
    test('lists the person\'s commits since the session started, on every branch, without merges, other authors or earlier work', () => {
      const { home, repo, sessionFile } = setup();
      try {
        commit(repo, 'before the session', ME, '2026-01-15T09:00:00');
        const first = commit(repo, 'first change', ME, '2026-01-15T10:30:00');
        commit(repo, 'their change', OTHER, '2026-01-15T10:45:00');
        // Left unmerged: only --all reaches it from main.
        git(repo, ['checkout', '-q', '-b', 'feature'], ME, '2026-01-15T11:00:00');
        const onBranch = commit(repo, 'branch change', ME, '2026-01-15T11:00:00');
        git(repo, ['checkout', '-q', 'main'], ME, '2026-01-15T11:05:00');
        git(repo, ['checkout', '-q', '-b', 'side'], ME, '2026-01-15T11:05:00');
        const onSide = commit(repo, 'side change', ME, '2026-01-15T11:06:00');
        git(repo, ['checkout', '-q', 'main'], ME, '2026-01-15T11:10:00');
        git(repo, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], ME, '2026-01-15T11:10:00');

        runHook(home, repo);
        const header = headerOf(sessionFile);
        assert.ok(header.includes('**Commits:**'), header);
        assert.ok(header.includes(`- ${first} first change`), header);
        assert.ok(header.includes(`- ${onBranch} branch change`), `a commit on an unmerged branch is listed:\n${header}`);
        assert.ok(header.includes(`- ${onSide} side change`), header);
        for (const absent of ['before the session', 'their change', 'merge side']) {
          assert.ok(!header.includes(absent), `${absent} is not listed:\n${header}`);
        }
        assert.ok(header.includes('**Started:** 10:00'), 'the session start is kept');
      } finally {
        cleanup(home, repo);
      }
    }),

    test('work written before the session and only rewritten during it (rebase, amend) is not listed', () => {
      const { home, repo, sessionFile } = setup();
      try {
        commit(repo, 'rebased old work', ME, '2026-01-15T09:00:00', '2026-01-15T10:30:00');
        const fresh = commit(repo, 'fresh work', ME, '2026-01-15T10:40:00');
        runHook(home, repo);
        const header = headerOf(sessionFile);
        assert.ok(header.includes(`- ${fresh} fresh work`), header);
        assert.ok(!header.includes('rebased old work'), header);
      } finally {
        cleanup(home, repo);
      }
    }),

    test('the list is rebuilt on every run, never accumulated', () => {
      const { home, repo, sessionFile } = setup();
      try {
        commit(repo, 'only change', ME, '2026-01-15T10:30:00');
        runHook(home, repo);
        runHook(home, repo);
        const header = headerOf(sessionFile);
        assert.strictEqual(header.split('**Commits:**').length - 1, 1, header);
        assert.strictEqual(header.split('only change').length - 1, 1, header);
      } finally {
        cleanup(home, repo);
      }
    }),

    test('no commit since the start leaves the header without the field', () => {
      const { home, repo, sessionFile } = setup();
      try {
        commit(repo, 'before the session', ME, '2026-01-15T09:00:00');
        runHook(home, repo);
        assert.ok(!headerOf(sessionFile).includes('**Commits:**'));
      } finally {
        cleanup(home, repo);
      }
    }),

    test('outside a git repository the hook still writes the session without the field', () => {
      const { home, repo, sessionFile } = setup();
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-n33-plain-'));
      try {
        runHook(home, plain, EMAIL_FROM_ENV);
        const header = headerOf(sessionFile);
        assert.ok(header.includes('**Last Updated:**'));
        assert.ok(!header.includes('**Commits:**'));
      } finally {
        cleanup(home, repo, plain);
      }
    }),
  ];

  cleanup(GIT_HOME);
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
