/**
 * Tests for scripts/hooks/goose-guardian-adapter.js
 *
 * Goose's PreToolUse hook wire contract -- {event, session_id,
 * matcher_context, tool_name, tool_input, working_dir} on stdin, exit code
 * 2 to block -- confirmed against aaif-goose/goose's own
 * docs/guides/context-engineering/hooks.md.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'goose-guardian-adapter.js');
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
  console.log('\n=== Testing goose-guardian-adapter ===\n');

  let passed = 0;
  let failed = 0;

  if (test('maps a developer__shell PreToolUse event to a Guardian Bash input', () => {
    const mapped = buildGuardianInput({
      event: 'PreToolUse',
      session_id: 'abc',
      matcher_context: 'echo hi',
      tool_name: 'developer__shell',
      tool_input: { command: 'echo hi' },
      working_dir: '/Users/example/project',
    });
    assert.deepStrictEqual(mapped, { tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: '/Users/example/project' });
  })) passed++; else failed++;

  if (test('omits cwd when working_dir is not a string', () => {
    const mapped = buildGuardianInput({ tool_name: 'developer__shell', tool_input: { command: 'echo hi' } });
    assert.strictEqual('cwd' in mapped, false);
  })) passed++; else failed++;

  if (test('returns null for a non-shell tool_name (developer__text_editor, ...)', () => {
    assert.strictEqual(buildGuardianInput({ tool_name: 'developer__text_editor', tool_input: {} }), null);
  })) passed++; else failed++;

  if (test('returns null for a developer__shell event with no tool_input.command', () => {
    assert.strictEqual(buildGuardianInput({ tool_name: 'developer__shell', tool_input: {} }), null);
    assert.strictEqual(buildGuardianInput({ tool_name: 'developer__shell' }), null);
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
      event: 'PreToolUse',
      tool_name: 'developer__shell',
      tool_input: { command: 'rm -rf /' },
    });
    assert.strictEqual(result.code, 2);
    assert.ok(result.stderr.length > 0, 'expected a reason on stderr');
  })) passed++; else failed++;

  if (test('CLI: allows a safe allowlisted command (exit 0)', () => {
    const result = runAdapterCli({
      event: 'PreToolUse',
      tool_name: 'developer__shell',
      tool_input: { command: 'git status' },
    });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, '');
  })) passed++; else failed++;

  if (test('CLI: non-shell tool_name (developer__text_editor) exits 0 with no output', () => {
    const result = runAdapterCli({
      event: 'PreToolUse',
      tool_name: 'developer__text_editor',
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
      event: 'PreToolUse',
      tool_name: 'developer__shell',
      tool_input: { command: 'git status', padding: oversizedPadding },
    });
    const result = runAdapterCli(oversizedInput);
    assert.strictEqual(result.code, 2, `Expected fail-closed on truncated oversized input, got exit ${result.code}`);
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
