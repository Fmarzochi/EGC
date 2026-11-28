'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { CLI_TIMEOUT_MS } = require('../fixtures/subprocess-timeouts');

process.env.EGC_GUARDIAN_CLI = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');

const REPO_ROOT = path.join(__dirname, '..', '..');
const extensionPath = path.join(REPO_ROOT, 'scripts', 'hooks', 'pi-egc-extension.js');
const extension = require(extensionPath);
const DRIVER = path.join(__dirname, '..', 'fixtures', 'pi-extension-driver.js');

// The extension driven the way pi drives it, in a process of its own with a
// home of its own, so the memory, the bus store and the Team Brain log are
// the test's.
function drive(home, extensionFile, payload) {
  const result = spawnSync(process.execPath, [DRIVER, extensionFile, JSON.stringify(payload)], {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), CLAUDE_PROJECT_DIR: '', PWD: '' },
  });
  return { code: result.status, output: parseJson(result.stdout), stdout: result.stdout || '', stderr: result.stderr || '' };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) { // NOSONAR: a non-JSON answer is what the assertion reports
    return null;
  }
}

// A home with a state store, and a project the state file is keyed by.
function sessionHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-pi-session-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.egc', 'state'), { recursive: true });
  const project = path.join(root, 'work', 'demo');
  fs.mkdirSync(project, { recursive: true });
  return { root, home, project, stateFile: path.join(home, '.egc', 'state', 'work--demo.md') };
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

async function main() {
  console.log('\n=== Testing pi-egc-extension ===\n');

  await test('the extension registers the gates on tool_call and the session work on before_agent_start, agent_end and session_shutdown, as a default export too (#1499)', async () => {
    const handlers = [];
    const pi = { on: (event, handler) => handlers.push([event, handler]) };
    extension(pi);
    assert.deepStrictEqual(handlers.map(([event]) => event), ['tool_call', 'before_agent_start', 'agent_end', 'session_shutdown']);
    assert.strictEqual(extension.default, extension, 'jiti loads the default export');
  });

  await test('a destructive bash command is blocked with the Guardian reason (#1499)', async () => {
    const result = extension.handleToolCall({ toolName: 'bash', input: { command: 'rm -rf /' } }, { cwd: '/work' });
    assert.strictEqual(result.block, true);
    assert.match(result.reason, /destructive/);
  });

  await test('an edit or write of a protected path is blocked (#1499)', async () => {
    for (const toolName of ['edit', 'write']) {
      const result = extension.handleToolCall({ toolName, input: { path: '/home/person/.ssh/id_rsa', content: 'x' } }, {});
      assert.strictEqual(result?.block, true, toolName);
    }
  });

  await test('a harmless bash command goes through, and other tools are left alone (#1499)', async () => {
    const event = { toolName: 'bash', input: { command: 'echo hello' } };
    assert.strictEqual(extension.handleToolCall(event, {}), undefined);
    assert.strictEqual(typeof event.input.command, 'string');
    assert.strictEqual(extension.handleToolCall({ toolName: 'read', input: { path: '/home/person/.ssh/id_rsa' } }, {}), undefined);
    assert.strictEqual(extension.handleToolCall({ toolName: 'bash', input: {} }, {}), undefined);
    assert.strictEqual(extension.handleToolCall({}, {}), undefined);
  });

  await test('an edit that puts a denied command into a shell script is blocked, in every shape Pi sends (#1499)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-pi-edit-'));
    try {
      const script = path.join(dir, 'deploy.sh');
      fs.writeFileSync(script, '#!/bin/sh\necho ready\n');
      const edit = { oldText: 'echo ready', newText: 'rm -rf /' };
      for (const input of [
        { path: script, edits: [edit] },
        { path: script, edits: JSON.stringify([edit]) },
        { path: script, edits: edit },
        { path: script, ...edit },
      ]) {
        const result = extension.handleToolCall({ toolName: 'edit', input }, { cwd: dir });
        assert.strictEqual(result?.block, true, JSON.stringify(input.edits ?? 'top-level'));
      }
      const harmless = extension.handleToolCall({ toolName: 'edit', input: { path: script, edits: [{ oldText: 'echo ready', newText: 'echo done' }] } }, { cwd: dir });
      assert.strictEqual(harmless, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('a bash command the Crusher compresses is rewritten in place (#1499)', async () => {
    const saved = process.env.EGC_ASSUME_EGC_CLI;
    process.env.EGC_ASSUME_EGC_CLI = '1';
    try {
      const event = { toolName: 'bash', input: { command: 'git log' } };
      assert.strictEqual(extension.handleToolCall(event, {}), undefined);
      assert.strictEqual(event.input.command, 'egc run git log');
    } finally {
      if (saved === undefined) delete process.env.EGC_ASSUME_EGC_CLI; else process.env.EGC_ASSUME_EGC_CLI = saved;
    }
  });

  await test('the handler pi calls returns the same answer (#1499)', async () => {
    const handlers = new Map();
    extension({ on: (event, fn) => handlers.set(event, fn) });
    const result = await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'rm -rf /' } }, { cwd: '/work' });
    assert.strictEqual(result.block, true);
  });

  await test('the first agent run of a session gets the project memory as a hidden message, and the next runs get nothing', async () => {
    const { root, home, project, stateFile } = sessionHome();
    try {
      fs.writeFileSync(stateFile, '# Project State\n- pi resumes feature Z\n');
      const run = drive(home, extensionPath, { cwd: project, sessionId: 'pi-1', steps: [{ event: 'before_agent_start' }, { event: 'before_agent_start' }] });
      assert.strictEqual(run.code, 0, run.stderr);
      assert.ok(run.output, `the driver answers JSON, got: ${run.stdout.slice(0, 200)}`);
      const [first, second] = run.output.answers;
      assert.strictEqual(first.message.customType, 'egc-memory');
      assert.strictEqual(first.message.display, false, 'the memory is for the model, not for the screen');
      assert.ok(first.message.content.includes('EGC persistent memory'), 'the memory preamble is there');
      assert.ok(first.message.content.includes('pi resumes feature Z'), 'the state file is there');
      assert.strictEqual(second, null, 'the second run of the session gets no message');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('a project without memory gets nothing, and so does a run without a session id', async () => {
    const { root, home, project } = sessionHome();
    try {
      const run = drive(home, extensionPath, { cwd: project, sessionId: 'pi-empty', steps: [{ event: 'before_agent_start' }] });
      assert.strictEqual(run.code, 0, run.stderr);
      assert.deepStrictEqual(run.output.answers, [null], 'no memory, no notice, no message');
      const anonymous = drive(home, extensionPath, { cwd: project, sessionId: null, steps: [{ event: 'before_agent_start' }] });
      assert.strictEqual(anonymous.code, 0, anonymous.stderr);
      assert.deepStrictEqual(anonymous.output.answers, [null]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('the mesh notice rides the next run when the bus store moved, after the memory, and a quiet bus adds nothing', async () => {
    const { root, home, project, stateFile } = sessionHome();
    try {
      fs.writeFileSync(stateFile, '# Project State\n- pi resumes feature Z\n');
      const store = path.join(home, '.egc', 'memory', 'state.db');
      fs.mkdirSync(path.dirname(store), { recursive: true });
      fs.writeFileSync(store, '');
      const run = drive(home, extensionPath, {
        cwd: project,
        sessionId: 'pi-2',
        steps: [
          { event: 'before_agent_start' },
          { event: 'before_agent_start' },
          { event: 'before_agent_start', touch: store, advanceMs: 5000 },
        ],
      });
      assert.strictEqual(run.code, 0, run.stderr);
      const [first, quiet, moved] = run.output.answers;
      assert.ok(first.message.content.includes('pi resumes feature Z'), 'the memory comes first');
      assert.ok(first.message.content.includes('[egc-mesh]'), 'a store this session never looked at counts as moved on the first run');
      assert.ok(first.message.content.indexOf('pi resumes feature Z') < first.message.content.indexOf('[egc-mesh]'), 'the notice comes after the memory');
      assert.strictEqual(quiet, null, 'a quiet bus adds nothing');
      assert.ok(moved.message.content.startsWith('[egc-mesh]'), 'the notice alone once the store moved');
      assert.ok(!moved.message.content.includes('pi resumes feature Z'), 'the memory is not repeated');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('agent_end pushes the Team Brain in the background and session_shutdown waits for it, when the team asks for it', async () => {
    const { root, home, project, stateFile } = sessionHome();
    try {
      fs.writeFileSync(stateFile, '# Project State\n- pi resumes feature Z\n');
      fs.writeFileSync(path.join(home, '.egc', 'team.json'), JSON.stringify({ backend: 'git', remote: path.join(root, 'missing-remote.git'), branch: 'main', teamKey: 'ab'.repeat(32), autosync: true }));
      const run = drive(home, extensionPath, {
        cwd: project,
        sessionId: 'pi-3',
        steps: [
          { event: 'before_agent_start' },
          { event: 'agent_end', write: { path: stateFile, content: '# Project State\n- decided in this response\n' } },
          { event: 'session_shutdown' },
        ],
      });
      assert.strictEqual(run.code, 0, run.stderr);
      const log = fs.readFileSync(path.join(home, '.egc', 'logs', 'team-autosync.log'), 'utf8');
      assert.match(log, / session-start: /, 'the pull ran before the first run');
      assert.match(log, / session-end: /, 'the push ran after the response that changed the state');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('the installed extension restores the memory from the layout the pi plan writes, with every require of the runtime resolved', async () => {
    const { planInstallTargetScaffold } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'install-targets', 'registry.js'));
    const { root, home, project, stateFile } = sessionHome();
    const previous = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      const plan = planInstallTargetScaffold({ target: 'pi', repoRoot: REPO_ROOT, homeDir: home, projectRoot: project, modules: [] });
      for (const operation of plan.operations.filter(op => op.kind === 'copy-path')) {
        const source = operation.sourcePath || path.join(REPO_ROOT, ...operation.sourceRelativePath.split('/'));
        fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });
        if (fs.statSync(source).isDirectory()) fs.cpSync(source, operation.destinationPath, { recursive: true });
        else fs.copyFileSync(source, operation.destinationPath);
      }
      const installed = path.join(home, '.pi', 'agent', 'extensions', 'egc-guardian.js');
      assert.ok(fs.existsSync(installed), 'the plan copies the extension');
      fs.writeFileSync(stateFile, '# Project State\n- installed layout works\n');
      const run = drive(home, installed, { cwd: project, sessionId: 'pi-4', steps: [{ event: 'before_agent_start' }, { event: 'agent_end' }, { event: 'session_shutdown' }] });
      assert.strictEqual(run.code, 0, run.stderr);
      assert.strictEqual(run.stderr, '', 'nothing of the copied runtime failed to load');
      assert.ok(run.output && run.output.answers[0] && run.output.answers[0].message.content.includes('installed layout works'), `the installed copy restores the state, got: ${run.stdout.slice(0, 200)}`);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
