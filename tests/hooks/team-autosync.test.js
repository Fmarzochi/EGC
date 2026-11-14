/**
 * Tests for the Team Brain sync that runs by itself around a session
 * (#2059): the hooks that end a response push what changed, the hooks that
 * start a session pull before the state is read, both only when
 * ~/.egc/team.json says `autosync: true`, each inside its budget and silent
 * towards the tool. Two homes stand for two machines against one bare
 * remote, with the built memory server doing the sync.
 */
'use strict';

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { removeDirWithRetries } = require('../fixtures/remove-dir');
const { FULL_INSTALL_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');
const { suiteEnv } = require('../fixtures/suite-env');

const ROOT = path.join(__dirname, '..', '..');
const MEMORY_SERVER = path.join(ROOT, 'mcp', 'servers', 'egc-memory', 'build', 'index.js');
const TEAM_CLI = path.join(ROOT, 'scripts', 'team.js');
const SESSION_END = path.join(ROOT, 'scripts', 'hooks', 'session-end.js');
const CLAUDE_STOP = path.join(ROOT, 'scripts', 'hooks', 'claude-session-stop.js');
const CLAUDE_START = path.join(ROOT, 'scripts', 'hooks', 'claude-session-start.js');
const OPENCODE_START = path.join(ROOT, 'scripts', 'hooks', 'opencode-session-start.js');
const MEMORY_LOAD = path.join(ROOT, 'scripts', 'hooks', 'egc-memory-load.js');

const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(candidate => fs.existsSync(candidate)) || 'git';

// The directory name carries no word of the sync, so the silence checks
// below cannot be fooled by a path printed in the restored state.
const SUITE = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-session-hooks-'));
const REMOTE = path.join(SUITE, 'remote.git');
// The project sits under the same relative path in both homes, so the two
// machines name it alike without a git remote of its own.
const PROJECT_RELATIVE = ['work', 'project'];
const TRANSCRIPT = path.join(SUITE, 'transcripts', '12345678-1234-1234-1234-1234567890ab.jsonl');
const TIMEOUT_MS = FULL_INSTALL_TIMEOUT_MS;
// The budget the hooks give the sync; a hook that ends later than this did
// not honor it.
const HOOK_BUDGET_MS = 15000;

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

function envFor(home) {
  return { ...suiteEnv(process.env), HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: '', PWD: '' };
}

function git(args, cwd, home) {
  return execFileSync(GIT_BIN, args, { cwd, encoding: 'utf8', env: envFor(home), stdio: 'pipe' }).trim();
}

function commitCount(home) {
  try {
    return Number(git(['rev-list', '--count', 'main'], REMOTE, home));
  } catch {
    return 0;
  }
}

function machine(name) {
  const home = fs.mkdtempSync(path.join(SUITE, `${name}-`));
  const project = path.join(home, ...PROJECT_RELATIVE);
  fs.mkdirSync(project, { recursive: true });
  return { home, project };
}

function teamCli(home, args) {
  const run = spawnSync(process.execPath, [TEAM_CLI, ...args], { encoding: 'utf8', env: envFor(home), timeout: TIMEOUT_MS });
  assert.strictEqual(run.status, 0, `egc team ${args.join(' ')} failed:\n${run.stdout}\n${run.stderr}`);
  return run.stdout;
}

function teamConfig(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.egc', 'team.json'), 'utf8'));
}

function setAutosync(home, on) {
  fs.writeFileSync(path.join(home, '.egc', 'team.json'), JSON.stringify({ ...teamConfig(home), autosync: on }, null, 2));
}

// One update_state through the server, so the machine has state to ship.
function writeProjectState(home, project, context) {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'autosync-test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'update_state', arguments: { project_path: project, context } } },
  ];
  const run = spawnSync(process.execPath, [MEMORY_SERVER], {
    input: messages.map(message => JSON.stringify(message)).join('\n') + '\n',
    encoding: 'utf8',
    env: envFor(home),
    timeout: TIMEOUT_MS,
  });
  assert.ok(run.stdout.includes('Project memory updated'), `update_state did not go through:\n${run.stdout}\n${run.stderr}`);
}

function runHook(script, home, cwd, input) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [script], {
    cwd,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: envFor(home),
    timeout: TIMEOUT_MS,
  });
  return { ...run, elapsedMs: Date.now() - started };
}

function logLines(home) {
  const file = path.join(home, '.egc', 'logs', 'team-autosync.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function stateFiles(home) {
  const dir = path.join(home, '.egc', 'state');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.md')) : [];
}

function silentAboutTheSync(run) {
  return !run.stdout.includes('autosync') && !run.stderr.includes('autosync');
}

function runTests() {
  console.log('\n=== Testing the Team Brain sync around the session (#2059) ===\n');
  if (!fs.existsSync(MEMORY_SERVER)) {
    console.error(`[SKIP] memory server build not found at ${MEMORY_SERVER}. Run 'npm run build' in mcp/servers/egc-memory first.`);
    removeDirWithRetries(SUITE);
    process.exit(0);
  }
  fs.mkdirSync(REMOTE, { recursive: true });
  fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
  fs.writeFileSync(TRANSCRIPT, JSON.stringify({ type: 'user', message: { role: 'user', content: 'ship the state' } }) + '\n');
  const first = machine('first');
  const second = machine('second');
  let teamKey = null;
  const results = [];
  const run = (name, fn) => results.push(test(name, fn));

  try {
    git(['init', '--bare', '-q'], REMOTE, first.home);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], REMOTE, first.home);

    run('without a team, and with a team whose autosync is off, the hooks never sync', () => {
      writeProjectState(first.home, first.project, 'First machine, before the team.');
      let hook = runHook(SESSION_END, first.home, first.project, { transcript_path: TRANSCRIPT });
      assert.strictEqual(hook.status, 0, hook.stderr);
      assert.deepStrictEqual(logLines(first.home), [], 'no team: nothing to log');
      assert.ok(!fs.existsSync(path.join(first.home, '.egc', 'team-sync')), 'no team: no checkout appears');

      teamCli(first.home, ['init', '--backend', 'git', '--remote', REMOTE]);
      teamKey = teamConfig(first.home).teamKey;
      assert.strictEqual(teamConfig(first.home).autosync, undefined, 'init without --autosync leaves the switch off');
      hook = runHook(SESSION_END, first.home, first.project, { transcript_path: TRANSCRIPT });
      assert.strictEqual(hook.status, 0, hook.stderr);
      hook = runHook(CLAUDE_START, first.home, first.project, { cwd: first.project, hook_event_name: 'SessionStart' });
      assert.strictEqual(hook.status, 0, hook.stderr);
      assert.ok(hook.stdout.includes('First machine, before the team.'), `the local state is restored as before:\n${hook.stdout}`);
      assert.deepStrictEqual(logLines(first.home), [], 'autosync off: nothing to log');
      assert.strictEqual(commitCount(first.home), 0, 'autosync off: nothing reaches the remote');
    });

    run('with autosync on, the end of a response pushes the state that changed, and only then', () => {
      setAutosync(first.home, true);
      const hook = runHook(SESSION_END, first.home, first.project, { transcript_path: TRANSCRIPT });
      assert.strictEqual(hook.status, 0, hook.stderr);
      assert.strictEqual(commitCount(first.home), 1, `the remote gains one commit:\n${hook.stderr}\n${logLines(first.home).join('\n')}`);
      assert.ok(silentAboutTheSync(hook), `nothing about the sync reaches the tool:\n${hook.stdout}\n${hook.stderr}`);
      const lines = logLines(first.home);
      assert.strictEqual(lines.length, 1, lines.join('\n'));
      assert.match(lines[0], /session-end: ok: pulled \d+ files, pushed 1 commits$/);
      const stamp = JSON.parse(fs.readFileSync(path.join(first.home, '.egc', 'team-autosync.json'), 'utf8'));
      assert.strictEqual(stamp.ok, true);
      assert.strictEqual(stamp.reason, 'session-end');
      assert.ok(Number.isFinite(Date.parse(stamp.lastRun)), stamp.lastRun);

      const again = runHook(SESSION_END, first.home, first.project, { transcript_path: TRANSCRIPT });
      assert.strictEqual(again.status, 0, again.stderr);
      assert.strictEqual(commitCount(first.home), 1, 'no state changed since the last run: no sync, no commit');
      assert.strictEqual(logLines(first.home).length, 1, 'a run that was not needed is not logged');

      writeProjectState(first.home, first.project, 'First machine, after the team.');
      const stop = runHook(CLAUDE_STOP, first.home, first.project, { session_id: 's1', cwd: first.project, transcript_path: TRANSCRIPT });
      assert.strictEqual(stop.status, 0, stop.stderr);
      assert.strictEqual(commitCount(first.home), 2, `the Claude stop hook pushes the state update_state wrote:\n${logLines(first.home).join('\n')}`);
      assert.ok(stop.stdout.includes('"session_id":"s1"'), `the stop hook still passes its input through:\n${stop.stdout}`);
      assert.ok(silentAboutTheSync(stop), `${stop.stdout}\n${stop.stderr}`);
      assert.strictEqual(logLines(first.home).length, 2, `the stop hook syncs once:\n${logLines(first.home).join('\n')}`);
      const shipped = git(['ls-tree', '-r', '--name-only', 'main'], REMOTE, first.home).split('\n');
      assert.ok(shipped.includes('state/work--project.md'), `the state document is on the remote: ${shipped.join(', ')}`);
      assert.ok(!shipped.some(entry => path.basename(entry).startsWith('.')), `the save-prompt marker of the stop hook stays on the machine: ${shipped.join(', ')}`);
    });

    run('with autosync on, the start of a session on the other machine pulls before the state is read', () => {
      teamCli(second.home, ['init', '--backend', 'git', '--remote', REMOTE, '--key', teamKey, '--autosync']);
      assert.strictEqual(teamConfig(second.home).autosync, true, 'init --autosync turns the switch on');
      assert.deepStrictEqual(stateFiles(second.home), [], 'the second machine starts with no state');

      const hook = runHook(CLAUDE_START, second.home, second.project, { cwd: second.project, hook_event_name: 'SessionStart' });
      assert.strictEqual(hook.status, 0, hook.stderr);
      assert.ok(hook.stdout.includes('First machine, after the team.'), `the state of the first machine is what the session restores:\n${hook.stdout}\n${hook.stderr}\n${logLines(second.home).join('\n')}`);
      assert.ok(stateFiles(second.home).length > 0, 'the pulled document now lives in the local state');
      const sealed = fs.readFileSync(path.join(second.home, '.egc', 'state', stateFiles(second.home)[0]));
      assert.strictEqual(sealed.subarray(0, 5).toString('utf8'), 'EGC1:', 'sealed with the key of this machine, as every state file is');
      assert.ok(silentAboutTheSync(hook), `the start hook stays silent about the sync:\n${hook.stderr}`);
      const lines = logLines(second.home);
      assert.strictEqual(lines.length, 1, lines.join('\n'));
      assert.match(lines[0], /session-start: ok: pulled \d+ files/);

      const opencode = runHook(OPENCODE_START, second.home, second.project, { cwd: second.project, session_id: 'oc' });
      assert.strictEqual(opencode.status, 0, opencode.stderr);
      assert.ok(JSON.parse(opencode.stdout).context.includes('First machine, after the team.'), opencode.stdout);
      const gemini = runHook(MEMORY_LOAD, second.home, second.project, { session_id: 'g' });
      assert.strictEqual(gemini.status, 0, gemini.stderr);
      assert.ok(JSON.parse(gemini.stdout).promptForAssistant.includes('First machine, after the team.'), gemini.stdout);
      assert.strictEqual(logLines(second.home).length, 3, 'each start hook syncs once');
    });

    run('with autosync on and a remote that cannot be reached, the hooks end inside the budget, exit 0, log one line and say nothing to the tool', () => {
      const away = `${REMOTE}.away`;
      fs.renameSync(REMOTE, away);
      try {
        const before = logLines(second.home).length;
        const start = runHook(CLAUDE_START, second.home, second.project, { cwd: second.project, hook_event_name: 'SessionStart' });
        assert.strictEqual(start.status, 0, start.stderr);
        assert.ok(start.elapsedMs < HOOK_BUDGET_MS, `the hook ends inside the budget, took ${start.elapsedMs}ms`);
        assert.ok(start.stdout.includes('First machine, after the team.'), 'the local state is still restored');
        assert.ok(silentAboutTheSync(start), `${start.stdout}\n${start.stderr}`);
        const lines = logLines(second.home);
        assert.strictEqual(lines.length, before + 1, lines.join('\n'));
        assert.match(lines.at(-1), /session-start: failed: /);

        writeProjectState(second.home, second.project, 'Second machine, offline.');
        const end = runHook(SESSION_END, second.home, second.project, { transcript_path: TRANSCRIPT });
        assert.strictEqual(end.status, 0, end.stderr);
        assert.ok(end.elapsedMs < HOOK_BUDGET_MS, `the hook ends inside the budget, took ${end.elapsedMs}ms`);
        assert.ok(end.stderr.includes('[SessionEnd] team autosync did not complete:'), `one line on stderr says the sync was abandoned:\n${end.stderr}`);
        assert.ok(!end.stdout.includes('autosync'), end.stdout);
        assert.match(logLines(second.home).at(-1), /session-end: failed: /);
      } finally {
        fs.renameSync(away, REMOTE);
      }
    });
  } finally {
    removeDirWithRetries(SUITE);
  }

  const failed = results.filter(result => !result).length;
  console.log(`\nResults: Passed: ${results.length - failed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
