/**
 * Tests for scripts/hooks/cursor-crusher-adapter.js
 *
 * Cursor's beforeShellExecution event (Guardian's slot) cannot rewrite a
 * command -- confirmed against https://cursor.com/docs/agent/hooks, whose
 * response schema for that event is only {permission, user_message,
 * agent_message}. This adapter instead runs on the generic preToolUse
 * event, whose response DOES support `updated_input`. Unlike the Guardian
 * adapter (see cursor-guardian-adapter.test.js), the Crusher is never a
 * security boundary: every failure mode here fails OPEN, never closed.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'cursor-crusher-adapter.js');
const { computeUpdatedInput } = require(adapterScript);

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
    env: { ...process.env, EGC_ASSUME_EGC_CLI: '1', ...env },
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
  console.log('\n=== Testing cursor-crusher-adapter ===\n');

  let passed = 0;
  let failed = 0;

  if (test('computeUpdatedInput rewrites a crushable Shell command', () => {
    process.env.EGC_ASSUME_EGC_CLI = '1';
    const updated = computeUpdatedInput({
      tool_name: 'Shell',
      tool_input: { command: 'git log --stat -n 300', working_directory: '/repo' },
    });
    assert.ok(updated, 'expected a rewritten tool_input');
    assert.strictEqual(updated.command, 'egc run git log --stat -n 300');
    assert.strictEqual(updated.working_directory, '/repo', 'must preserve other tool_input fields');
    delete process.env.EGC_ASSUME_EGC_CLI;
  })) passed++; else failed++;

  if (test('computeUpdatedInput returns null for a non-crushable Shell command', () => {
    process.env.EGC_ASSUME_EGC_CLI = '1';
    assert.strictEqual(computeUpdatedInput({ tool_name: 'Shell', tool_input: { command: 'echo hi' } }), null);
    delete process.env.EGC_ASSUME_EGC_CLI;
  })) passed++; else failed++;

  if (test('computeUpdatedInput returns null for a non-Shell tool_name', () => {
    process.env.EGC_ASSUME_EGC_CLI = '1';
    assert.strictEqual(
      computeUpdatedInput({ tool_name: 'Read', tool_input: { command: 'git log --stat -n 300' } }),
      null
    );
    delete process.env.EGC_ASSUME_EGC_CLI;
  })) passed++; else failed++;

  if (test('computeUpdatedInput returns null when there is no command', () => {
    assert.strictEqual(computeUpdatedInput({ tool_name: 'Shell', tool_input: {} }), null);
  })) passed++; else failed++;

  if (test('computeUpdatedInput returns null (does not throw) for a non-object event', () => {
    assert.strictEqual(computeUpdatedInput(null), null);
    assert.strictEqual(computeUpdatedInput('a string'), null);
    assert.strictEqual(computeUpdatedInput(42), null);
  })) passed++; else failed++;

  if (test('CLI: rewrites a crushable Shell command with updated_input.command', () => {
    const result = runAdapterCli({
      tool_name: 'Shell',
      tool_input: { command: 'git log --stat -n 300' },
      tool_use_id: 'abc123',
    });
    assert.strictEqual(result.code, 0);
    const response = JSON.parse(result.stdout);
    assert.strictEqual(response.permission, 'allow');
    assert.strictEqual(response.updated_input.command, 'egc run git log --stat -n 300');
  })) passed++; else failed++;

  if (test('CLI: a trivial Shell command allows with no updated_input (no false positive)', () => {
    const result = runAdapterCli({ tool_name: 'Shell', tool_input: { command: 'echo hi' } });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { permission: 'allow' });
  })) passed++; else failed++;

  if (test('CLI: a non-Shell tool call (e.g. Read) allows untouched', () => {
    const result = runAdapterCli({ tool_name: 'Read', tool_input: { path: '/etc/passwd' } });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { permission: 'allow' });
  })) passed++; else failed++;

  if (test('CLI: malformed stdin JSON fails OPEN (allow) -- Crusher is never a security boundary', () => {
    const result = runAdapterCli('not json');
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { permission: 'allow' });
  })) passed++; else failed++;

  if (test('CLI: a truncated oversized payload fails OPEN (allow), unlike the Guardian adapter\'s fail-closed', () => {
    const oversizedPadding = 'x'.repeat(2 * 1024 * 1024);
    const oversizedInput = JSON.stringify({
      tool_name: 'Shell',
      tool_input: { command: 'git log --stat -n 300' },
      padding: oversizedPadding,
    });
    const result = runAdapterCli(oversizedInput);
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { permission: 'allow' });
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
