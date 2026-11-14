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
const { buildTeamReport, printTeamReport, countStateDocuments, checkoutState } = require('../../scripts/lib/doctor-team');
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
      assert.ok(lines(report).includes('Team: not configured (egc team init --backend git --remote <url>)'));
      assert.ok(!lines(report).includes('WARNING'));
    })),

    test('a configured team shows the remote, the branch, the key, the last commit of the checkout, the state to seal and the autosync switch', () => withHome(home => {
      const { remote, checkout } = makeTeam(home, { autosync: true });
      const stateDir = path.join(home, '.egc', 'state');
      fs.mkdirSync(path.join(stateDir, 'repo--abc'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'flat.md'), 'x');
      fs.writeFileSync(path.join(stateDir, 'flat.md.hmac'), 'y');
      fs.writeFileSync(path.join(stateDir, '.save-prompt-flat'), 'z');
      fs.writeFileSync(path.join(stateDir, 'repo--abc', 'main--123.md'), 'x');
      fs.writeFileSync(path.join(home, '.egc', 'team-autosync.json'), JSON.stringify({ lastRun: '2026-11-14T06:00:00.000Z', reason: 'session-end', ok: true, detail: 'pulled 0 files, pushed 1 commits' }));
      const report = buildTeamReport(home, { env: ENV });
      assert.strictEqual(report.configured, true);
      assert.strictEqual(report.remote, remote);
      assert.strictEqual(report.branch, 'main');
      assert.strictEqual(report.keyPresent, true);
      assert.strictEqual(report.checkout, 'repository');
      assert.strictEqual(report.lastSyncTime, git(['log', '-1', '--format=%cI'], checkout), 'the last sync is the last commit of the checkout');
      assert.strictEqual(report.stateDocuments, 2, 'sidecars and hidden markers are not state to seal');
      assert.strictEqual(countStateDocuments(home), 2);
      assert.strictEqual(report.autosync, true);
      assert.deepStrictEqual(report.remoteCheck, { checked: true, reachable: true, reason: null }, 'a local bare remote is read');
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
      const report = buildTeamReport(home, { env: ENV });
      assert.strictEqual(report.keyPresent, false);
      assert.deepStrictEqual(report.warnings, ['Team key missing or invalid in ~/.egc/team.json: run egc team init again']);
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
      const report = buildTeamReport(home, { env: ENV });
      assert.strictEqual(report.checkout, 'not-a-repository');
      assert.strictEqual(checkoutState(path.join(home, '.egc', 'team-sync')), 'not-a-repository');
      assert.strictEqual(report.lastSyncTime, null);
      assert.ok(report.warnings.some(warning => warning.includes('is not a git repository')), report.warnings.join('\n'));
      assert.ok(lines(report).includes('  Last sync: never'));
    })),

    test('a team without a checkout yet reads never and raises no warning', () => withHome(home => {
      const remote = path.join(home, 'remote.git');
      fs.mkdirSync(remote, { recursive: true });
      git(['init', '--bare', '-q', '-b', 'main'], remote);
      writeTeamConfig({ backend: 'git', remote, branch: 'main', teamKey: KEY }, home);
      const report = buildTeamReport(home, { env: ENV });
      assert.strictEqual(report.checkout, 'absent');
      assert.strictEqual(report.lastSyncTime, null);
      assert.deepStrictEqual(report.warnings, []);
    })),

    test('a remote that cannot be read is a warning with the reason git gave, inside the budget', () => withHome(home => {
      makeTeam(home, { remote: path.join(home, 'no-such-remote.git') });
      const started = Date.now();
      const report = buildTeamReport(home, { env: ENV, remoteTimeoutMs: 5000 });
      assert.ok(Date.now() - started < 5000, 'the read of the remote ends inside its budget');
      assert.strictEqual(report.remoteCheck.checked, true);
      assert.strictEqual(report.remoteCheck.reachable, false);
      assert.ok(report.warnings.some(warning => warning.startsWith('The remote ') && warning.includes('cannot be read: ')), report.warnings.join('\n'));
      assert.ok(lines(report).includes('  Remote: cannot be read: '), lines(report));
    })),

    test('offline, the remote is not checked and the block says so without a warning', () => withHome(home => {
      makeTeam(home);
      const report = buildTeamReport(home, { env: ENV, offline: true });
      assert.deepStrictEqual(report.remoteCheck, { checked: false, reachable: null, reason: 'no network interface is up' });
      assert.deepStrictEqual(report.warnings, []);
      assert.ok(lines(report).includes('  Remote: not checked (no network interface is up)'));
    })),
  ];

  const failed = results.filter(result => !result).length;
  console.log(`\nResults: Passed: ${results.length - failed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
