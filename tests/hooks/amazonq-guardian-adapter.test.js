/**
 * Tests for scripts/hooks/amazonq-guardian-adapter.js
 *
 * Amazon Q's preToolUse hook wire contract -- {hook_event_name, cwd,
 * tool_name, tool_input} on stdin, exit code 2 to block -- is byte-for-byte
 * the same shape Kiro's CLI uses (see kiro-guardian-adapter.test.js), so
 * this mirrors that file's test structure exactly.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'amazonq-guardian-adapter.js');
const fakeCli = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');
const { buildGuardianInput } = require(adapterScript);

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

function runAdapterCli(input, env = {}) {
  const result = spawnSync('node', [adapterScript], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, EGC_GUARDIAN_CLI: fakeCli, ...env },
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function runTests() {
  console.log('\n=== Testing amazonq-guardian-adapter ===\n');

  let passed = 0;
  let failed = 0;

  if (test('maps an execute_bash preToolUse event to a Guardian Bash input', () => {
    const mapped = buildGuardianInput({
      hook_event_name: 'preToolUse',
      cwd: '/Users/example/project',
      tool_name: 'execute_bash',
      tool_input: { command: 'echo hi' },
    });
    assert.deepStrictEqual(mapped, { tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: '/Users/example/project' });
  })) passed++; else failed++;

  if (test('omits cwd when the event has none (not a string)', () => {
    const mapped = buildGuardianInput({ tool_name: 'execute_bash', tool_input: { command: 'echo hi' } });
    assert.strictEqual('cwd' in mapped, false);
  })) passed++; else failed++;

  if (test('returns null for a non-execute_bash tool_name (fs_read, fs_write, use_aws, ...)', () => {
    assert.strictEqual(buildGuardianInput({ tool_name: 'fs_read', tool_input: {} }), null);
    assert.strictEqual(buildGuardianInput({ tool_name: 'fs_write', tool_input: {} }), null);
    assert.strictEqual(buildGuardianInput({ tool_name: 'use_aws', tool_input: {} }), null);
  })) passed++; else failed++;

  if (test('returns null for an execute_bash event with no tool_input.command', () => {
    assert.strictEqual(buildGuardianInput({ tool_name: 'execute_bash', tool_input: {} }), null);
    assert.strictEqual(buildGuardianInput({ tool_name: 'execute_bash' }), null);
  })) passed++; else failed++;

  if (test('returns null (does not throw) for a non-object event, e.g. valid JSON "null"', () => {
    assert.strictEqual(buildGuardianInput(null), null);
    assert.strictEqual(buildGuardianInput('a string'), null);
    assert.strictEqual(buildGuardianInput(42), null);
  })) passed++; else failed++;

  if (test('CLI: a valid JSON "null" payload allows (exit 0) instead of crashing', () => {
    const result = runAdapterCli('null');
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (test('CLI: blocks a destructive command with exit 2 and a reason on stderr', () => {
    const result = runAdapterCli({
      hook_event_name: 'preToolUse',
      tool_name: 'execute_bash',
      tool_input: { command: 'rm -rf /' },
    });
    assert.strictEqual(result.code, 2);
    assert.ok(result.stderr.length > 0, 'expected a reason on stderr');
  })) passed++; else failed++;

  if (test('CLI: allows a safe allowlisted command (exit 0)', () => {
    const result = runAdapterCli({
      hook_event_name: 'preToolUse',
      tool_name: 'execute_bash',
      tool_input: { command: 'git status' },
    });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, '');
  })) passed++; else failed++;

  if (test('CLI: non-bash tool_name (fs_write) exits 0 with no output', () => {
    const result = runAdapterCli({
      hook_event_name: 'preToolUse',
      tool_name: 'fs_write',
      tool_input: { path: '/tmp/some-file.js' },
    });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(result.stderr, '');
  })) passed++; else failed++;

  if (test('CLI: malformed (non-truncated) stdin JSON fails open (exit 0)', () => {
    const result = runAdapterCli('not json');
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (test('CLI: an oversized payload that gets truncated into invalid JSON fails CLOSED (exit 2), not open', () => {
    const oversizedPadding = 'x'.repeat(2 * 1024 * 1024);
    const oversizedInput = JSON.stringify({
      hook_event_name: 'preToolUse',
      tool_name: 'execute_bash',
      tool_input: { command: 'git status', padding: oversizedPadding },
    });
    const result = runAdapterCli(oversizedInput);
    assert.strictEqual(result.code, 2, `Expected fail-closed on truncated oversized input, got exit ${result.code}`);
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
