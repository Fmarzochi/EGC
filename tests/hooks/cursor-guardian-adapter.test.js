/**
 * Tests for scripts/hooks/cursor-guardian-adapter.js
 *
 * Cursor's beforeShellExecution hook uses a different wire contract than
 * Claude Code's PreToolUse hook (see windsurf-guardian-adapter.test.js for
 * the same pattern this mirrors) -- this file exercises both the pure
 * translation function and the real CLI entrypoint end to end.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'cursor-guardian-adapter.js');
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
  console.log('\n=== Testing cursor-guardian-adapter ===\n');

  let passed = 0;
  let failed = 0;

  if (test('maps a Cursor beforeShellExecution event to a Guardian Bash input', () => {
    const mapped = buildGuardianInput({ command: 'echo hi', cwd: '/Users/example/project' });
    assert.deepStrictEqual(mapped, { tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: '/Users/example/project' });
  })) passed++; else failed++;

  if (test('omits cwd when the event has none (not a string)', () => {
    const mapped = buildGuardianInput({ command: 'echo hi' });
    assert.strictEqual('cwd' in mapped, false);
  })) passed++; else failed++;

  if (test('returns null for an event with no command', () => {
    assert.strictEqual(buildGuardianInput({ cwd: '/tmp' }), null);
  })) passed++; else failed++;

  if (test('CLI: blocks a destructive command with exit 2 and a JSON deny response', () => {
    const result = runAdapterCli({ command: 'rm -rf /', cwd: '/tmp' });
    assert.strictEqual(result.code, 2);
    const response = JSON.parse(result.stdout);
    assert.strictEqual(response.permission, 'deny');
    assert.ok(response.user_message.length > 0, 'expected a user_message');
    assert.ok(response.agent_message.length > 0, 'expected an agent_message');
  })) passed++; else failed++;

  if (test('CLI: allows a safe allowlisted command (exit 0, permission allow)', () => {
    const result = runAdapterCli({ command: 'git status', cwd: '/tmp' });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { permission: 'allow' });
  })) passed++; else failed++;

  if (test('CLI: event with no command allows (exit 0, permission allow)', () => {
    const result = runAdapterCli({ cwd: '/tmp' });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { permission: 'allow' });
  })) passed++; else failed++;

  if (test('CLI: malformed (non-truncated) stdin JSON fails open (exit 0, allow)', () => {
    const result = runAdapterCli('not json');
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { permission: 'allow' });
  })) passed++; else failed++;

  if (test('CLI: an oversized payload that gets truncated into invalid JSON fails CLOSED (exit 2), not open', () => {
    // Same fail-closed-on-truncation guard as windsurf-guardian-adapter.js:
    // padding the payload past the 1MB stdin cap must not let an attacker
    // dodge validation by making the JSON unparseable.
    const oversizedPadding = 'x'.repeat(2 * 1024 * 1024);
    const oversizedInput = JSON.stringify({ command: 'rm -rf /', cwd: '/tmp', padding: oversizedPadding });
    const result = runAdapterCli(oversizedInput);
    assert.strictEqual(result.code, 2, `Expected fail-closed on truncated oversized input, got exit ${result.code}`);
    const response = JSON.parse(result.stdout);
    assert.strictEqual(response.permission, 'deny');
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
