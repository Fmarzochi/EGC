/**
 * Tests for the Cursor preToolUse GateGuard translation layer:
 *   - .cursor/hooks/adapter.js (normalizeCursorToolName, buildGateGuardInput,
 *     translateGateGuardResult)
 *   - .cursor/hooks/before-tool-use.js (the preToolUse entrypoint that wires
 *     those helpers to scripts/hooks/gateguard-fact-force.js)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const adapter = require('../../.cursor/hooks/adapter');
const hookScript = path.join(__dirname, '..', '..', '.cursor', 'hooks', 'before-tool-use.js');

const tmpRoot = process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp';

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

function makeStateDir() {
  return fs.mkdtempSync(path.join(tmpRoot, 'cursor-gateguard-test-'));
}

function runHook(input, env = {}) {
  const rawInput = typeof input === 'string' ? input : JSON.stringify(input);
  const result = spawnSync('node', [hookScript], {
    input: rawInput,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function parseOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (_) {
    return null;
  }
}

function runTests() {
  console.log('\n=== Testing Cursor GateGuard translation ===\n');

  let passed = 0;
  let failed = 0;

  // --- Unit tests: adapter.js translation helpers ---

  if (test('normalizeCursorToolName maps Shell to Bash', () => {
    assert.strictEqual(adapter.normalizeCursorToolName('Shell'), 'Bash');
    assert.strictEqual(adapter.normalizeCursorToolName('shell'), 'Bash');
  })) passed++; else failed++;

  if (test('normalizeCursorToolName leaves other tool names unchanged', () => {
    assert.strictEqual(adapter.normalizeCursorToolName('Write'), 'Write');
    assert.strictEqual(adapter.normalizeCursorToolName('Read'), 'Read');
    assert.strictEqual(adapter.normalizeCursorToolName(''), '');
    assert.strictEqual(adapter.normalizeCursorToolName(undefined), '');
  })) passed++; else failed++;

  if (test('buildGateGuardInput maps tool_name, file_path, command, session and transcript', () => {
    const cursorInput = {
      tool_name: 'Shell',
      tool_input: { command: 'npm test', working_directory: '/project' },
      conversation_id: 'conv-123',
      transcript_path: '/tmp/transcript.jsonl',
    };
    const built = adapter.buildGateGuardInput(cursorInput);
    assert.strictEqual(built.tool_name, 'Bash', 'Shell should normalize to Bash');
    assert.strictEqual(built.tool_input.command, 'npm test');
    assert.strictEqual(built.session_id, 'conv-123');
    assert.strictEqual(built.transcript_path, '/tmp/transcript.jsonl');
  })) passed++; else failed++;

  if (test('buildGateGuardInput falls back across path/filePath for file_path', () => {
    const viaPath = adapter.buildGateGuardInput({ tool_name: 'Write', tool_input: { path: '/src/a.js' } });
    assert.strictEqual(viaPath.tool_input.file_path, '/src/a.js');

    const viaFilePath = adapter.buildGateGuardInput({ tool_name: 'Write', tool_input: { filePath: '/src/b.js' } });
    assert.strictEqual(viaFilePath.tool_input.file_path, '/src/b.js');

    const viaSnakeCase = adapter.buildGateGuardInput({ tool_name: 'Write', tool_input: { file_path: '/src/c.js' } });
    assert.strictEqual(viaSnakeCase.tool_input.file_path, '/src/c.js');
  })) passed++; else failed++;

  if (test('buildGateGuardInput handles missing tool_input without throwing', () => {
    const built = adapter.buildGateGuardInput({ tool_name: 'Write' });
    assert.strictEqual(built.tool_input.file_path, '');
    assert.strictEqual(built.tool_input.command, '');
  })) passed++; else failed++;

  if (test('translateGateGuardResult passes through an allow (pass-through) result', () => {
    const passthroughInput = { tool_name: 'Read', tool_input: {} };
    assert.deepStrictEqual(adapter.translateGateGuardResult(passthroughInput), { permission: 'allow' });
  })) passed++; else failed++;

  if (test('translateGateGuardResult converts a Claude-shaped deny into Cursor permission:deny', () => {
    const denyResult = {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: '[Fact-Forcing Gate]\n\nsome reason',
        },
      }),
      exitCode: 0,
    };
    const translated = adapter.translateGateGuardResult(denyResult);
    assert.strictEqual(translated.permission, 'deny');
    assert.strictEqual(translated.user_message, '[Fact-Forcing Gate]\n\nsome reason');
    assert.strictEqual(translated.agent_message, '[Fact-Forcing Gate]\n\nsome reason');
  })) passed++; else failed++;

  if (test('translateGateGuardResult fails open on malformed deny-shaped stdout', () => {
    const malformed = { stdout: '{ not valid json', exitCode: 0 };
    assert.deepStrictEqual(adapter.translateGateGuardResult(malformed), { permission: 'allow' });
  })) passed++; else failed++;

  if (test('translateGateGuardResult fails open on a state-persistence warning (stderr-only result)', () => {
    const stateError = { stderr: '[Fact-Forcing Gate] GateGuard state could not be persisted', exitCode: 0 };
    assert.deepStrictEqual(adapter.translateGateGuardResult(stateError), { permission: 'allow' });
  })) passed++; else failed++;

  // --- Integration tests: full before-tool-use.js process ---

  let stateDir = makeStateDir();
  if (test('direct invocation denies the first Write and produces Cursor deny JSON', () => {
    const input = {
      tool_name: 'Write',
      tool_input: { file_path: '/src/cursor-write-a.js' },
      conversation_id: 'session-a',
    };
    const result = runHook(input, { GATEGUARD_STATE_DIR: stateDir, EGC_SESSION_ID: 'session-a' });
    assert.strictEqual(result.code, 0, 'exit code should be 0 (Cursor reads permission from JSON, not exit code)');
    const output = parseOutput(result.stdout);
    assert.ok(output, 'should produce JSON output');
    assert.strictEqual(output.permission, 'deny');
    assert.ok(output.user_message.includes('Fact-Forcing Gate'));
    assert.ok(output.user_message.includes('/src/cursor-write-a.js'));
    assert.ok(output.agent_message.includes('Fact-Forcing Gate'));
  })) passed++; else failed++;

  if (test('direct invocation allows the retried Write on the same file', () => {
    const input = {
      tool_name: 'Write',
      tool_input: { file_path: '/src/cursor-write-a.js' },
      conversation_id: 'session-a',
    };
    const result = runHook(input, { GATEGUARD_STATE_DIR: stateDir, EGC_SESSION_ID: 'session-a' });
    assert.strictEqual(result.code, 0);
    const output = parseOutput(result.stdout);
    assert.deepStrictEqual(output, { permission: 'allow' });
  })) passed++; else failed++;

  stateDir = makeStateDir();
  if (test('direct invocation maps Shell tool_name to the Bash gate and denies the first routine command', () => {
    const input = {
      tool_name: 'Shell',
      tool_input: { command: 'npm test', working_directory: '/project' },
      conversation_id: 'session-b',
    };
    const result = runHook(input, { GATEGUARD_STATE_DIR: stateDir, EGC_SESSION_ID: 'session-b' });
    assert.strictEqual(result.code, 0);
    const output = parseOutput(result.stdout);
    assert.strictEqual(output.permission, 'deny');
    assert.ok(output.user_message.includes('current user request'));
  })) passed++; else failed++;

  if (test('direct invocation allows a retried Shell command in the same session', () => {
    const input = {
      tool_name: 'Shell',
      tool_input: { command: 'npm test', working_directory: '/project' },
      conversation_id: 'session-b',
    };
    const result = runHook(input, { GATEGUARD_STATE_DIR: stateDir, EGC_SESSION_ID: 'session-b' });
    assert.deepStrictEqual(parseOutput(result.stdout), { permission: 'allow' });
  })) passed++; else failed++;

  stateDir = makeStateDir();
  if (test('direct invocation denies a destructive Shell command with the destructive gate message', () => {
    const input = {
      tool_name: 'Shell',
      tool_input: { command: 'rm -rf /tmp/cursor-demo' },
      conversation_id: 'session-c',
    };
    const result = runHook(input, { GATEGUARD_STATE_DIR: stateDir, EGC_SESSION_ID: 'session-c' });
    const output = parseOutput(result.stdout);
    assert.strictEqual(output.permission, 'deny');
    assert.ok(output.user_message.includes('Destructive command detected'));
    assert.ok(output.user_message.includes('rollback'));
  })) passed++; else failed++;

  stateDir = makeStateDir();
  if (test('direct invocation passes through tool names GateGuard does not gate (e.g. Read)', () => {
    const input = { tool_name: 'Read', tool_input: { file_path: '/src/cursor-write-a.js' }, conversation_id: 'session-d' };
    const result = runHook(input, { GATEGUARD_STATE_DIR: stateDir, EGC_SESSION_ID: 'session-d' });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(parseOutput(result.stdout), { permission: 'allow' });
  })) passed++; else failed++;

  stateDir = makeStateDir();
  if (test('direct invocation allows malformed stdin JSON instead of crashing', () => {
    const result = runHook('{ not valid json', { GATEGUARD_STATE_DIR: stateDir, EGC_SESSION_ID: 'session-e' });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(parseOutput(result.stdout), { permission: 'allow' });
  })) passed++; else failed++;

  stateDir = makeStateDir();
  if (test('direct invocation respects EGC_DISABLED_HOOKS for the edit/write gate id', () => {
    const input = { tool_name: 'Write', tool_input: { file_path: '/src/cursor-disabled.js' }, conversation_id: 'session-f' };
    const result = runHook(input, {
      GATEGUARD_STATE_DIR: stateDir,
      EGC_SESSION_ID: 'session-f',
      EGC_DISABLED_HOOKS: 'pre:edit-write:gateguard-fact-force',
    });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(parseOutput(result.stdout), { permission: 'allow' });
  })) passed++; else failed++;

  stateDir = makeStateDir();
  if (test('direct invocation respects EGC_HOOK_PROFILE=minimal (gate not in minimal profile)', () => {
    const input = { tool_name: 'Write', tool_input: { file_path: '/src/cursor-minimal.js' }, conversation_id: 'session-g' };
    const result = runHook(input, {
      GATEGUARD_STATE_DIR: stateDir,
      EGC_SESSION_ID: 'session-g',
      EGC_HOOK_PROFILE: 'minimal',
    });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(parseOutput(result.stdout), { permission: 'allow' });
  })) passed++; else failed++;

  stateDir = makeStateDir();
  if (test('direct invocation respects EGC_GATEGUARD=off end to end', () => {
    const input = { tool_name: 'Write', tool_input: { file_path: '/src/cursor-off.js' }, conversation_id: 'session-h' };
    const result = runHook(input, {
      GATEGUARD_STATE_DIR: stateDir,
      EGC_SESSION_ID: 'session-h',
      EGC_GATEGUARD: 'off',
    });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(parseOutput(result.stdout), { permission: 'allow' });
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
