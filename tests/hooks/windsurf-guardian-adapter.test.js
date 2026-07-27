/**
 * Tests for scripts/hooks/windsurf-guardian-adapter.js
 *
 * Windsurf's pre_run_command hook uses a different wire contract than
 * Claude Code's PreToolUse hook (see windsurf-gateguard-adapter.js for the
 * same distinction) -- this file exercises both the pure translation
 * function and the real CLI entrypoint end to end, including the
 * cwd-preservation and oversized-input fail-closed fixes from the
 * 2026-07-27 cubic-dev-ai review.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'windsurf-guardian-adapter.js');
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
  console.log('\n=== Testing windsurf-guardian-adapter ===\n');

  let passed = 0;
  let failed = 0;

  if (test('maps pre_run_command to a Guardian Bash input', () => {
    const mapped = buildGuardianInput({
      agent_action_name: 'pre_run_command',
      tool_info: { command_line: 'echo hi' },
    });
    assert.deepStrictEqual(mapped, { tool_name: 'Bash', tool_input: { command: 'echo hi' } });
  })) passed++; else failed++;

  if (test('preserves tool_info.cwd on the mapped input (relative protected-path checks need it)', () => {
    const mapped = buildGuardianInput({
      agent_action_name: 'pre_run_command',
      tool_info: { command_line: 'cat .ssh/id_rsa', cwd: '/Users/example/project' },
    });
    assert.strictEqual(mapped.cwd, '/Users/example/project');
  })) passed++; else failed++;

  if (test('omits cwd when tool_info has none (not a string)', () => {
    const mapped = buildGuardianInput({
      agent_action_name: 'pre_run_command',
      tool_info: { command_line: 'echo hi' },
    });
    assert.strictEqual('cwd' in mapped, false);
  })) passed++; else failed++;

  if (test('returns null for unmapped Windsurf events (pre_write_code, pre_read_code, ...)', () => {
    assert.strictEqual(buildGuardianInput({ agent_action_name: 'pre_write_code', tool_info: {} }), null);
    assert.strictEqual(buildGuardianInput({ agent_action_name: 'pre_read_code', tool_info: {} }), null);
  })) passed++; else failed++;

  if (test('returns null for pre_run_command with no command_line', () => {
    assert.strictEqual(buildGuardianInput({ agent_action_name: 'pre_run_command', tool_info: {} }), null);
  })) passed++; else failed++;

  if (test('CLI: blocks a destructive command with exit 2 and a reason on stderr', () => {
    const result = runAdapterCli({
      agent_action_name: 'pre_run_command',
      tool_info: { command_line: 'rm -rf /' },
    });
    assert.strictEqual(result.code, 2);
    assert.ok(result.stderr.length > 0, 'expected a reason on stderr');
  })) passed++; else failed++;

  if (test('CLI: allows a safe allowlisted command (exit 0)', () => {
    const result = runAdapterCli({
      agent_action_name: 'pre_run_command',
      tool_info: { command_line: 'git status' },
    });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, '');
  })) passed++; else failed++;

  if (test('CLI: unmapped event (pre_write_code) exits 0 with no output', () => {
    const result = runAdapterCli({
      agent_action_name: 'pre_write_code',
      tool_info: { file_path: '/tmp/some-file.js' },
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
    // Pads well past the adapter's 1MB stdin cap so JSON.parse() sees a
    // truncated, syntactically invalid document -- before the fix this hit
    // the generic "malformed input" catch and allowed the command through
    // unvalidated, letting an attacker pad any command past the cap to
    // bypass the Guardian entirely.
    const oversizedPadding = 'x'.repeat(2 * 1024 * 1024);
    const oversizedInput = JSON.stringify({
      agent_action_name: 'pre_run_command',
      tool_info: { command_line: 'rm -rf /', padding: oversizedPadding },
    });
    const result = runAdapterCli(oversizedInput);
    assert.strictEqual(result.code, 2, `Expected fail-closed on truncated oversized input, got exit ${result.code}`);
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
