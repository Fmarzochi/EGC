/**
 * GitHub Copilot's session hooks: scripts/hooks/copilot-session-start.js
 * answers the project memory as additionalContext for Copilot's payload
 * (sessionId, cwd, source), pulls the Team Brain when the team asks for it,
 * answers an empty object without memory, and runs from the layout
 * `egc install --target copilot` writes (~/.github/scripts); and
 * scripts/hooks/team-sync-stop.js pushes after a response that changed the
 * state. Runs against a home of its own.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SESSION_START = path.join(REPO_ROOT, 'scripts', 'hooks', 'copilot-session-start.js');
const STOP = path.join(REPO_ROOT, 'scripts', 'hooks', 'team-sync-stop.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

function runHook(script, home, payload, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      CLAUDE_PROJECT_DIR: '',
      PWD: '',
      ...extraEnv,
    },
    timeout: CLI_TIMEOUT_MS,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) { // NOSONAR: a non-JSON answer is what the assertion reports
    return null;
  }
}

function copyTree(relativePath, destination) {
  fs.cpSync(path.join(REPO_ROOT, relativePath), destination, {
    recursive: true,
    filter: source => !source.includes(`${path.sep}__pycache__`),
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-copilot-session-'));
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, '.egc', 'state'), { recursive: true });
const project = path.join(root, 'work', 'demo');
fs.mkdirSync(project, { recursive: true });
const copilotPayload = { sessionId: 'copilot-session-1', timestamp: 1763690000000, cwd: project, source: 'startup' };
const logFile = path.join(home, '.egc', 'logs', 'team-autosync.log');

try {
  console.log('\n=== Testing the Copilot session hooks ===\n');

  test('SessionStart answers the project memory as additionalContext for the cwd Copilot sends', () => {
    fs.writeFileSync(path.join(home, '.egc', 'state', 'work--demo.md'), '# Project State\n- copilot resumes feature Z\n');
    const result = runHook(SESSION_START, home, copilotPayload);
    assert.strictEqual(result.code, 0, result.stderr);
    const output = parseJson(result.stdout);
    assert.ok(output, `the hook answers JSON, got: ${result.stdout.slice(0, 200)}`);
    assert.ok(output.additionalContext.includes('EGC persistent memory'), 'the memory preamble is there');
    assert.ok(output.additionalContext.includes('copilot resumes feature Z'), 'the state file is there');
    assert.strictEqual(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.strictEqual(output.hookSpecificOutput.additionalContext, output.additionalContext);
  });

  test('SessionStart runs the Team Brain pull first when the team asks for it, and Stop pushes after a change', () => {
    fs.writeFileSync(path.join(home, '.egc', 'team.json'), JSON.stringify({ backend: 'git', remote: path.join(root, 'missing-remote.git'), branch: 'main', teamKey: 'ab'.repeat(32), autosync: true }));
    const start = runHook(SESSION_START, home, { ...copilotPayload, sessionId: 'copilot-session-2' });
    assert.strictEqual(start.code, 0, start.stderr);
    assert.match(fs.readFileSync(logFile, 'utf8'), / session-start: /, 'the pull ran for the session start');
    fs.writeFileSync(path.join(home, '.egc', 'state', 'work--demo.md'), '# Project State\n- copilot resumes feature Z\n- decided in this response\n');
    const stop = runHook(STOP, home, { sessionId: 'copilot-session-2', timestamp: 1763690100000, cwd: project });
    assert.strictEqual(stop.code, 0, stop.stderr);
    assert.deepStrictEqual(parseJson(stop.stdout), {}, 'Stop answers an empty object');
    assert.match(fs.readFileSync(logFile, 'utf8'), / session-end: /, 'the push ran after the response');
    fs.rmSync(path.join(home, '.egc', 'team.json'), { force: true });
  });

  test('SessionStart answers an empty object when the project has no memory', () => {
    fs.rmSync(path.join(home, '.egc', 'state', 'work--demo.md'), { force: true });
    const result = runHook(SESSION_START, home, { ...copilotPayload, sessionId: 'copilot-session-3' });
    assert.strictEqual(result.code, 0, result.stderr);
    assert.deepStrictEqual(parseJson(result.stdout), {});
  });

  test('the hooks run from the layout the Copilot install writes, with the runtime kept under scripts/', () => {
    const installed = path.join(root, 'home-installed');
    fs.mkdirSync(path.join(installed, '.egc', 'state'), { recursive: true });
    copyTree('scripts/hooks', path.join(installed, '.github', 'scripts', 'hooks'));
    copyTree('scripts/lib', path.join(installed, '.github', 'scripts', 'lib'));
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'check-state-leak.js'), path.join(installed, '.github', 'scripts', 'check-state-leak.js'));
    fs.writeFileSync(path.join(installed, '.egc', 'state', 'work--demo.md'), '# Project State\n- installed layout works\n');
    const result = runHook(path.join(installed, '.github', 'scripts', 'hooks', 'copilot-session-start.js'), installed, copilotPayload);
    assert.strictEqual(result.code, 0, result.stderr);
    const output = parseJson(result.stdout);
    assert.ok(output && output.additionalContext.includes('installed layout works'), `the installed copy restores the state, got: ${result.stdout.slice(0, 200)}`);
    const stop = runHook(path.join(installed, '.github', 'scripts', 'hooks', 'team-sync-stop.js'), installed, {});
    assert.strictEqual(stop.code, 0, stop.stderr);
    assert.deepStrictEqual(parseJson(stop.stdout), {});
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
