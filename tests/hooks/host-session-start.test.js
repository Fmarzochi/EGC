/**
 * The session hooks of the hosts that read the Claude Code hook format and
 * name their fields their own way: scripts/lib/host-session-start.js takes
 * the project from project_path, the workspace roots, cwd or working_dir and
 * the session from session_id, sessionId or conversation_id, pulls the Team
 * Brain when the team asks for it, restores the project memory and answers
 * it as additionalContext at the top and under hookSpecificOutput; each host
 * has a wrapper in scripts/hooks (Qwen Code, CodeBuddy, Junie, Auggie, Goose,
 * Droid); and scripts/hooks/team-sync-stop.js pushes after a response that
 * changed the state. Runs against a home of its own.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

const REPO_ROOT = path.join(__dirname, '..', '..');
const HOOKS = path.join(REPO_ROOT, 'scripts', 'hooks');
const STOP = path.join(HOOKS, 'team-sync-stop.js');
const HOSTS = ['qwen', 'codebuddy', 'junie', 'auggie', 'goose', 'droid', 'openhands', 'grok', 'letta'];

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

function hookEnv(home, extraEnv = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CLAUDE_PROJECT_DIR: '',
    PWD: '',
    ...extraEnv,
  };
}

function runHook(script, home, payload, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: hookEnv(home, extraEnv),
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

// The runtime as an install lays it out: every file the plan of the target
// copies, each at the destination the plan names, so a require one of them
// makes and the plan forgot fails here and not on the machine of the person.
function copyPlanned(operations) {
  for (const operation of operations) {
    const source = operation.sourcePath || path.join(REPO_ROOT, ...operation.sourceRelativePath.split('/'));
    fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });
    if (fs.statSync(source).isDirectory()) fs.cpSync(source, operation.destinationPath, { recursive: true });
    else fs.copyFileSync(source, operation.destinationPath);
  }
}

// The requires a copied file makes only as a fallback, inside its own
// try/catch, for a layout this one is not: the flattened egc/lib of Claude
// Code (session-marker.js and propagate-state.js next to the hook) and the
// version read from a package.json two levels up, which an installed hook
// does without.
const OPTIONAL_REQUIRES = new Set([
  'scripts/lib/session-start-adapter.js needs ./session-marker',
  'scripts/check-state-leak.js needs ./propagate-state',
  'scripts/lib/team-mcp-client.js needs ../../package.json',
]);

// Every relative require of the given files, resolved on the installed tree;
// comment lines are not read, and the fallbacks above are not demanded.
function unresolvedRequires(root, files) {
  const missing = [];
  for (const file of files) {
    const label = path.relative(root, file).split(path.sep).join('/');
    const code = fs.readFileSync(file, 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    for (const match of code.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)) {
      const need = `${label} needs ${match[2]}`;
      if (OPTIONAL_REQUIRES.has(need)) continue;
      const target = path.resolve(path.dirname(file), match[2]);
      const candidates = [target, `${target}.js`, path.join(target, 'index.js')];
      if (!candidates.some(candidate => fs.existsSync(candidate))) missing.push(need);
    }
  }
  return missing;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-host-session-'));
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, '.egc', 'state'), { recursive: true });
const project = path.join(root, 'work', 'demo');
fs.mkdirSync(project, { recursive: true });
const elsewhere = path.join(root, 'work', 'elsewhere');
fs.mkdirSync(elsewhere, { recursive: true });
const stateFile = path.join(home, '.egc', 'state', 'work--demo.md');
const logFile = path.join(home, '.egc', 'logs', 'team-autosync.log');

// What each host sends its SessionStart hook, by its own documentation: each
// names the project and the session its own way.
const payloads = {
  qwen: { session_id: 'qwen-1', transcript_path: '', cwd: project, hook_event_name: 'SessionStart', source: 'startup' },
  codebuddy: { session_id: 'codebuddy-1', transcript_path: '', cwd: project, hook_event_name: 'SessionStart', source: 'startup' },
  junie: { hook_event_name: 'SessionStart', session_id: 'junie-1', cwd: elsewhere, project_path: project, source: 'startup' },
  auggie: { hook_event_name: 'SessionStart', conversation_id: 'auggie-1', workspace_roots: [project], cwd: elsewhere },
  goose: { event: 'SessionStart', session_id: 'goose-1', working_dir: project },
  droid: { session_id: 'droid-1', transcript_path: '', cwd: project, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup' },
  openhands: { event_type: 'session_start', session_id: 'openhands-1', working_dir: project },
  grok: { hookEventName: 'SessionStart', sessionId: 'grok-1', cwd: elsewhere, workspaceRoot: project },
  letta: { event_type: 'SessionStart', working_directory: project },
};

try {
  console.log('\n=== Testing the session hooks of the hosts in the Claude Code hook format ===\n');

  test('the project is the root the host names before its working directory, and the session is the id the host gives', () => {
    const { projectOf, sessionIdOf, sessionStartAnswer } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'host-session-start.js'));
    assert.strictEqual(projectOf(payloads.junie), project, 'Junie: project_path before cwd');
    assert.strictEqual(projectOf(payloads.auggie), project, 'Auggie: the first workspace root before cwd');
    assert.strictEqual(projectOf(payloads.goose), project, 'Goose: working_dir');
    assert.strictEqual(projectOf(payloads.qwen), project, 'Qwen: cwd');
    assert.strictEqual(projectOf(payloads.grok), project, 'Grok: workspaceRoot before cwd');
    assert.strictEqual(projectOf(payloads.letta), project, 'Letta: working_directory');
    assert.strictEqual(sessionIdOf(payloads.letta), undefined, 'Letta names no session');
    assert.strictEqual(projectOf({}), process.cwd(), 'nothing named: the working directory of the hook');
    assert.strictEqual(sessionIdOf(payloads.auggie), 'auggie-1', 'Auggie names the conversation');
    assert.strictEqual(sessionIdOf({ sessionId: 'camel' }), 'camel');
    assert.strictEqual(sessionIdOf({}), undefined);
    assert.deepStrictEqual(sessionStartAnswer(''), {});
    assert.deepStrictEqual(sessionStartAnswer('memory'), { additionalContext: 'memory', hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'memory' } });
  });

  for (const host of HOSTS) {
    test(`${host}: SessionStart answers the project memory in both shapes for the project the host names`, () => {
      fs.writeFileSync(stateFile, `# Project State\n- ${host} resumes feature Z\n`);
      const result = runHook(path.join(HOOKS, `${host}-session-start.js`), home, payloads[host]);
      assert.strictEqual(result.code, 0, result.stderr);
      const output = parseJson(result.stdout);
      assert.ok(output, `the hook answers JSON, got: ${result.stdout.slice(0, 200)}`);
      assert.ok(output.additionalContext.includes('EGC persistent memory'), 'the memory preamble is there');
      assert.ok(output.additionalContext.includes(`${host} resumes feature Z`), 'the state file is there');
      assert.strictEqual(output.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.strictEqual(output.hookSpecificOutput.additionalContext, output.additionalContext);
    });
  }

  test('SessionStart answers an empty object when the project has no memory', () => {
    fs.rmSync(stateFile, { force: true });
    const result = runHook(path.join(HOOKS, 'qwen-session-start.js'), home, { ...payloads.qwen, session_id: 'qwen-2' });
    assert.strictEqual(result.code, 0, result.stderr);
    assert.deepStrictEqual(parseJson(result.stdout), {});
  });

  test('SessionStart runs the Team Brain pull first when the team asks for it, and Stop pushes after a change', () => {
    fs.writeFileSync(path.join(home, '.egc', 'team.json'), JSON.stringify({ backend: 'git', remote: path.join(root, 'missing-remote.git'), branch: 'main', teamKey: 'ab'.repeat(32), autosync: true }));
    const start = runHook(path.join(HOOKS, 'junie-session-start.js'), home, { ...payloads.junie, session_id: 'junie-2' });
    assert.strictEqual(start.code, 0, start.stderr);
    assert.match(fs.readFileSync(logFile, 'utf8'), / session-start: /, 'the pull ran for the session start');
    fs.writeFileSync(stateFile, '# Project State\n- decided in this response\n');
    const stop = runHook(STOP, home, { session_id: 'junie-2', cwd: project, hook_event_name: 'Stop' });
    assert.strictEqual(stop.code, 0, stop.stderr);
    assert.deepStrictEqual(parseJson(stop.stdout), {}, 'Stop answers an empty object');
    assert.match(fs.readFileSync(logFile, 'utf8'), / session-end: /, 'the push ran after the response');
    fs.rmSync(path.join(home, '.egc', 'team.json'), { force: true });
  });

  test('a payload that is not JSON starts the session without context, and never breaks it', () => {
    const result = spawnSync(process.execPath, [path.join(HOOKS, 'droid-session-start.js')], {
      input: 'not json',
      encoding: 'utf8',
      env: hookEnv(home),
      cwd: elsewhere,
      timeout: CLI_TIMEOUT_MS,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(parseJson(result.stdout), {}, 'no project named and no memory for the working directory');
  });

  test('the hooks run from the layout the plan of a target writes, and every require of the session runtime resolves on that tree', () => {
    const { planInstallTargetScaffold } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'install-targets', 'registry.js'));
    const { HOST_SESSION_HOOK_MODULE_ID } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'claude-settings-hook-copy-operations.js'));
    const installed = path.join(root, 'home-installed');
    fs.mkdirSync(path.join(installed, '.egc', 'state'), { recursive: true });
    const projectInstalled = path.join(root, 'project-installed');
    const qwenRoot = path.join(projectInstalled, '.qwen');
    const plan = planInstallTargetScaffold({ target: 'qwen', repoRoot: REPO_ROOT, homeDir: installed, projectRoot: projectInstalled, modules: [] });
    const copies = plan.operations.filter(operation => operation.kind === 'copy-path');
    copyPlanned(copies);
    const sessionFiles = copies.filter(operation => operation.moduleId === HOST_SESSION_HOOK_MODULE_ID).map(operation => operation.destinationPath);
    assert.ok(sessionFiles.length > 0, 'the plan copies the session runtime');
    assert.deepStrictEqual(unresolvedRequires(qwenRoot, sessionFiles), [], 'every file the session runtime requires is on the installed tree');
    const sessionStart = plan.operations.find(operation => operation.hookEvent === 'SessionStart');
    assert.ok(sessionStart && fs.existsSync(sessionStart.hookScriptPath), 'the SessionStart entry names a script the plan copied');
    const stop = plan.operations.find(operation => operation.hookEvent === 'Stop');
    assert.ok(stop && fs.existsSync(stop.hookScriptPath), 'the Stop entry names a script the plan copied');
    fs.writeFileSync(path.join(installed, '.egc', 'state', 'work--demo.md'), '# Project State\n- installed layout works\n');
    const result = runHook(sessionStart.hookScriptPath, installed, payloads.qwen);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(result.stderr, '', 'nothing of the copied runtime failed to load');
    const output = parseJson(result.stdout);
    assert.ok(output && output.additionalContext.includes('installed layout works'), `the installed copy restores the state, got: ${result.stdout.slice(0, 200)}`);
    const stopped = runHook(stop.hookScriptPath, installed, {});
    assert.strictEqual(stopped.code, 0, stopped.stderr);
    assert.deepStrictEqual(parseJson(stopped.stdout), {});
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
