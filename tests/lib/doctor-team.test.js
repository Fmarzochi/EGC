/**
 * Tests for scripts/lib/doctor-team.js: the Team block of egc doctor
 * (#2058), built from files and one read of the remote, never from the
 * memory server.
 */
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { suiteEnv } = require('../fixtures/suite-env');
const {
  buildTeamReport,
  printTeamReport,
  countStateDocuments,
  checkoutState,
  displayRemote,
  quietGitEnvironment,
} = require('../../scripts/lib/doctor-team');
const { writeTeamConfig } = require('../../scripts/lib/team-config');

const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';
const ENV = suiteEnv(process.env);
const KEY = 'ab'.repeat(32);

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

function git(args, cwd) {
  return execFileSync(GIT_BIN, args, { cwd, encoding: 'utf8', env: ENV, stdio: 'pipe' }).trim();
}

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-doctor-team-'));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// A bare remote and a checkout under the home with one commit, the shape
// egc team sync leaves behind.
function makeTeam(home, overrides = {}) {
  const remote = path.join(home, 'remote.git');
  fs.mkdirSync(remote, { recursive: true });
  git(['init', '--bare', '-q', '-b', 'main'], remote);
  const checkout = path.join(home, '.egc', 'team-sync');
  fs.mkdirSync(path.join(checkout, 'state'), { recursive: true });
  git(['init', '-q', '-b', 'main'], checkout);
  git(['config', 'user.email', 'doctor@example.test'], checkout);
  git(['config', 'user.name', 'Doctor'], checkout);
  git(['remote', 'add', 'origin', remote], checkout);
  fs.writeFileSync(path.join(checkout, 'state', 'proj.md'), 'sealed');
  git(['add', '-A'], checkout);
  git(['commit', '-q', '-m', 'sync: team memory update'], checkout);
  git(['push', '-q', 'origin', 'main'], checkout);
  writeTeamConfig({ backend: 'git', remote, branch: 'main', teamKey: KEY, ...overrides }, home);
  return { remote, checkout };
}

function lines(report) {
  const out = [];
  printTeamReport(report, line => out.push(line));
  return out.join('\n');
}

function runTests() {
  console.log('\n=== Testing the Team block of egc doctor (#2058) ===\n');
  const results = [
    test('no team configuration is one informational line and no warning', () => withHome(home => {
      const report = buildTeamReport(home, { env: ENV });
      assert.strictEqual(report.configured, false);
      assert.strictEqual(report.warningCount, 0);
      assert.ok(lines(report).includes('Team: not configured (egc team init --backend git --remote <url>, with --key <team key> to join a team)'));
      assert.ok(!lines(report).includes('WARNING'));
    })),

    test('a team.json that cannot be read as a configuration is a warning, never the line of a machine without a team', () => withHome(home => {
      fs.mkdirSync(path.join(home, '.egc'), { recursive: true });
      fs.writeFileSync(path.join(home, '.egc', 'team.json'), 'not the JSON egc team init writes');
      const report = buildTeamReport(home, { env: ENV, offline: false });
      assert.strictEqual(report.configured, false);
      assert.strictEqual(report.unreadable, true);
      assert.strictEqual(report.warningCount, 1);
      assert.ok(report.warnings[0].startsWith('The team configuration at ~/.egc/team.json exists but cannot be read as one'), report.warnings[0]);
      assert.ok(report.warnings[0].endsWith('run egc team init --backend git --remote <url> --key <team key>'), report.warnings[0]);
      const text = lines(report);
      assert.ok(text.includes('Team: configuration unreadable (~/.egc/team.json)'), text);
      assert.ok(text.includes('[WARNING]'), text);
      assert.ok(text.includes('Team summary: warnings=1'), text);
    })),

    test('git runs with prompts off and ssh in batch mode, while a command of the person stands as it is', () => {
      const plain = quietGitEnvironment({ PATH: 'x' });
      assert.strictEqual(plain.GIT_TERMINAL_PROMPT, '0');
      assert.strictEqual(plain.GIT_SSH_COMMAND, 'ssh -oBatchMode=yes');
      assert.strictEqual(quietGitEnvironment({ GIT_SSH_COMMAND: 'ssh -i key' }).GIT_SSH_COMMAND, 'ssh -i key', 'the command of the person stands, as the sync keeps it');
      const program = quietGitEnvironment({ GIT_SSH: 'plink' });
      assert.strictEqual(program.GIT_SSH, 'plink');
      assert.strictEqual(program.GIT_SSH_COMMAND, undefined, 'GIT_SSH alone stands: a GIT_SSH_COMMAND would take over it');
    }),

    test('a configured team shows the remote, the branch, the key, the last commit of the checkout, the state to seal and the autosync switch', () => withHome(home => {
      const { remote, checkout } = makeTeam(home, { autosync: true });
      const stateDir = path.join(home, '.egc', 'state');
      fs.mkdirSync(path.join(stateDir, 'repo--abc'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'flat.md'), 'x');
      fs.writeFileSync(path.join(stateDir, 'flat.md.hmac'), 'y');
      fs.writeFileSync(path.join(stateDir, '.save-prompt-flat'), 'z');
      fs.writeFileSync(path.join(stateDir, 'repo--abc', 'main--123.md'), 'x');
      fs.mkdirSync(path.join(stateDir, '.private'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, '.private', 'notes.md'), 'never sealed');
      fs.writeFileSync(path.join(home, '.egc', 'team-autosync.json'), JSON.stringify({ lastRun: '2026-11-14T06:00:00.000Z', reason: 'session-end', ok: true, detail: 'pulled 0 files, pushed 1 commits' }));
      const report = buildTeamReport(home, { env: ENV, offline: false });
      assert.strictEqual(report.configured, true);
      assert.strictEqual(report.remote, remote);
      assert.strictEqual(report.branch, 'main');
      assert.strictEqual(report.keyPresent, true);
      assert.strictEqual(report.backendSupported, true);
      assert.strictEqual(report.checkout, 'repository');
      assert.strictEqual(report.checkoutRemote, remote);
      assert.strictEqual(report.checkoutBranch, 'main');
      assert.strictEqual(report.lastSyncTime, git(['log', '-1', '--format=%cI'], checkout), 'the last sync is the last commit of the checkout');
      assert.strictEqual(report.stateDocuments, 2, 'sidecars, hidden markers and documents under a hidden directory are not state to seal');
      assert.strictEqual(countStateDocuments(home), 2);
      assert.strictEqual(report.autosync, true);
      assert.deepStrictEqual(report.remoteCheck, { checked: true, reachable: true, branchFound: true, reason: null }, 'a local bare remote is read, with the branch');
      assert.deepStrictEqual(report.warnings, []);
      const text = lines(report);
      assert.ok(text.includes(`Team: git ${remote}, branch main, key present`), text);
      assert.ok(text.includes(`  Last sync: ${report.lastSyncTime}`), text);
      assert.ok(text.includes('  Local state: 2 files to seal'), text);
      assert.ok(text.includes('  Autosync: on (last run 2026-11-14T06:00:00.000Z, session-end, ok)'), text);
      assert.ok(text.includes('  Remote: reachable'), text);
      assert.ok(text.includes('Team summary: warnings=0'), text);
    })),

    test('a key that is missing or not 64 hex characters is one warning, counted once', () => withHome(home => {
      makeTeam(home, { teamKey: 'not-a-key' });
      const report = buildTeamReport(home, { env: ENV, offline: false });
      assert.strictEqual(report.keyPresent, false);
      assert.deepStrictEqual(report.warnings, ['Team key missing or invalid in ~/.egc/team.json: run egc team init --backend git --remote <url> --key <team key>'], 'the hint names the key: an init without it would start a new team');
      assert.strictEqual(report.warningCount, 1);
      const text = lines(report);
      assert.ok(text.includes('key missing or invalid'), text);
      assert.strictEqual(text.split('[WARNING]').length - 1, 1, text);
    })),

    test('a checkout directory that is not a git repository is a warning, and the last sync reads never', () => withHome(home => {
      const remote = path.join(home, 'remote.git');
      fs.mkdirSync(remote, { recursive: true });
      git(['init', '--bare', '-q', '-b', 'main'], remote);
      fs.mkdirSync(path.join(home, '.egc', 'team-sync', 'state'), { recursive: true });
      writeTeamConfig({ backend: 'git', remote, branch: 'main', teamKey: KEY }, home);
      const report = buildTeamReport(home, { env: ENV, offline: false });
      assert.strictEqual(report.checkout, 'not-a-repository');
      assert.strictEqual(checkoutState(path.join(home, '.egc', 'team-sync')), 'not-a-repository');
      assert.strictEqual(report.lastSyncTime, null);
      assert.ok(report.warnings.some(warning => warning.includes('is not a git repository') && warning.endsWith('--key <team key>')), report.warnings.join('\n'));
      assert.ok(lines(report).includes('  Last sync: never'));
    })),

    test('a team without a checkout yet reads never, sees its remote without a branch and raises no warning', () => withHome(home => {
      const remote = path.join(home, 'remote.git');
      fs.mkdirSync(remote, { recursive: true });
      git(['init', '--bare', '-q', '-b', 'main'], remote);
      writeTeamConfig({ backend: 'git', remote, branch: 'main', teamKey: KEY }, home);
      const report = buildTeamReport(home, { env: ENV, offline: false });
      assert.strictEqual(report.checkout, 'absent');
      assert.strictEqual(report.lastSyncTime, null);
      assert.deepStrictEqual(report.remoteCheck, { checked: true, reachable: true, branchFound: false, reason: null });
      assert.deepStrictEqual(report.warnings, []);
      assert.ok(lines(report).includes('  Remote: reachable, no branch pushed yet'), lines(report));
    })),

    test('a checkout that follows another remote or another branch than team.json is a warning, since the next sync would refuse it', () => withHome(home => {
      const { remote } = makeTeam(home);
      const other = path.join(home, 'other.git');
      fs.mkdirSync(other, { recursive: true });
      git(['init', '--bare', '-q', '-b', 'main'], other);
      writeTeamConfig({ backend: 'git', remote: other, branch: 'main', teamKey: KEY }, home);
      let report = buildTeamReport(home, { env: ENV, offline: false });
      assert.strictEqual(report.checkoutRemote, remote);
      assert.ok(report.warnings.some(warning => warning.startsWith('The sync checkout at ~/.egc/team-sync follows ') && warning.endsWith('remove the directory and run egc team init --backend git --remote <url> --key <team key>')), report.warnings.join('\n'));
      assert.strictEqual(report.warningCount, 1, 'the other remote is reachable, only the checkout is wrong');

      writeTeamConfig({ backend: 'git', remote, branch: 'develop', teamKey: KEY }, home);
      report = buildTeamReport(home, { env: ENV, offline: false });
      assert.strictEqual(report.checkoutBranch, 'main');
      assert.ok(report.warnings.some(warning => warning.includes('is on branch main, not the configured develop')), report.warnings.join('\n'));
      assert.deepStrictEqual(report.remoteCheck, { checked: true, reachable: true, branchFound: false, reason: null }, 'the remote has no develop branch');
    })),

    test('a backend that is not git is a warning, and the remote is not read for it', () => withHome(home => {
      makeTeam(home, { backend: 's3' });
      const report = buildTeamReport(home, { env: ENV, offline: false });
      assert.strictEqual(report.backendSupported, false);
      assert.deepStrictEqual(report.remoteCheck, { checked: false, reachable: null, branchFound: null, reason: 'backend not supported' });
      assert.ok(report.warnings.some(warning => warning.startsWith('Backend "s3" in ~/.egc/team.json is not supported, only git is')), report.warnings.join('\n'));
      assert.strictEqual(report.warningCount, 1);
    })),

    test('a remote that cannot be read is a warning with the reason git gave', () => withHome(home => {
      makeTeam(home, { remote: path.join(home, 'no-such-remote.git') });
      const report = buildTeamReport(home, { env: ENV, offline: false });
      assert.strictEqual(report.remoteCheck.checked, true);
      assert.strictEqual(report.remoteCheck.reachable, false);
      assert.ok(report.warnings.some(warning => warning.startsWith('The remote ') && warning.includes('cannot be read: ')), report.warnings.join('\n'));
      assert.ok(lines(report).includes('  Remote: cannot be read: '), lines(report));
    })),

    test('a remote that does not answer is cut at the budget, and the reason names the budget', () => withHome(home => {
      makeTeam(home, { remote: 'ssh://localhost/team.git' });
      // The ssh command git runs never answers: it keeps its stdout to git
      // open and sleeps past the budget, closing only the stderr it shares
      // with the doctor so the read ends when git is cut.
      const stub = path.join(home, 'ssh-that-never-answers.js');
      fs.writeFileSync(stub, "require('fs').closeSync(2);\nsetTimeout(() => {}, 2500);\n");
      const quote = file => `"${file.replace(/\\/g, '/')}"`;
      const env = { ...ENV, GIT_SSH_COMMAND: `${quote(process.execPath)} ${quote(stub)}` };
      const started = Date.now();
      const report = buildTeamReport(home, { env, offline: false, remoteTimeoutMs: 1000 });
      assert.ok(Date.now() - started < 6000, 'the read ends at the budget, not when the remote feels like answering');
      assert.deepStrictEqual(report.remoteCheck, { checked: true, reachable: false, branchFound: null, reason: 'did not answer within 1000 ms' });
      assert.ok(report.warnings.includes('The remote ssh://localhost/team.git cannot be read: did not answer within 1000 ms'), report.warnings.join('\n'));
    })),

    test('a credential inside the remote URL never reaches the block, its warnings or the report', () => withHome(home => {
      makeTeam(home, { remote: 'https://user:secret-token@127.0.0.1:9/team.git' });
      const report = buildTeamReport(home, { env: ENV, offline: false, remoteTimeoutMs: 4000 });
      assert.strictEqual(report.remote, 'https://127.0.0.1:9/team.git');
      const everything = `${lines(report)}\n${JSON.stringify(report)}`;
      assert.ok(!everything.includes('secret-token'), everything);
      assert.ok(report.warnings.some(warning => warning.startsWith('The remote https://127.0.0.1:9/team.git cannot be read: ')), report.warnings.join('\n'));
      assert.strictEqual(displayRemote('ssh://git@host/team.git'), 'ssh://host/team.git');
      assert.strictEqual(displayRemote('git@github.com:org/team.git'), 'git@github.com:org/team.git', 'an scp-like remote carries no credential');
      assert.strictEqual(displayRemote(undefined), null);
    })),

    test('offline, the remote is not checked and the block says so without a warning', () => withHome(home => {
      makeTeam(home);
      const report = buildTeamReport(home, { env: ENV, offline: true });
      assert.deepStrictEqual(report.remoteCheck, { checked: false, reachable: null, branchFound: null, reason: 'no network interface is up' });
      assert.deepStrictEqual(report.warnings, []);
      assert.ok(lines(report).includes('  Remote: not checked (no network interface is up)'));
    })),
  ];

  const failed = results.filter(result => !result).length;
  console.log(`\nResults: Passed: ${results.length - failed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
