/**
 * Tests for scripts/hooks/cline-guardian-adapter.js
 *
 * Cline's PreToolUse input shape is {preToolUse: {toolName, parameters}},
 * not Claude Code's {tool_name, tool_input}, so the remapping IS tested
 * here (unlike Junie). Cline's output schema (validateHookOutput in the
 * real cline/cline source, confirmed 2026-07-29) only recognizes cancel/
 * contextModification/errorMessage -- there is no exit-code contract like
 * Junie's (Cline honors the JSON body regardless of exit code), so every
 * case here asserts exit 0 and checks `cancel` in the body instead.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'cline-guardian-adapter.js');
const fakeCli = path.join(__dirname, '..', 'fixtures', 'fake-guardian-cli.js');

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
  console.log('\n=== Testing cline-guardian-adapter ===\n');

  let passed = 0;
  let failed = 0;

  if (test('CLI: allows a safe execute_command (exit 0, {cancel: false})', () => {
    const result = runAdapterCli({ preToolUse: { toolName: 'execute_command', parameters: { command: 'git status' } } });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { cancel: false });
  })) passed++; else failed++;

  if (test('CLI: blocks a destructive execute_command ({cancel: true, errorMessage})', () => {
    const result = runAdapterCli({ preToolUse: { toolName: 'execute_command', parameters: { command: 'rm -rf /' } } });
    assert.strictEqual(result.code, 0, 'Cline honors the JSON body regardless of exit code');
    const response = JSON.parse(result.stdout);
    assert.strictEqual(response.cancel, true);
    assert.ok(response.errorMessage && response.errorMessage.length > 0, 'expected a non-empty errorMessage');
  })) passed++; else failed++;

  if (test('CLI: a non-execute_command tool (e.g. read_file) allows untouched', () => {
    const result = runAdapterCli({ preToolUse: { toolName: 'read_file', parameters: { command: 'rm -rf /', path: '/etc/passwd' } } });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { cancel: false });
  })) passed++; else failed++;

  if (test('CLI: execute_command with no command parameter allows (exit 0)', () => {
    const result = runAdapterCli({ preToolUse: { toolName: 'execute_command', parameters: {} } });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { cancel: false });
  })) passed++; else failed++;

  if (test('CLI: malformed stdin JSON fails open ({cancel: false})', () => {
    const result = runAdapterCli('not json');
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { cancel: false });
  })) passed++; else failed++;

  if (test('CLI: a truncated oversized payload fails CLOSED ({cancel: true}) -- Guardian is a security boundary', () => {
    const oversizedPadding = 'x'.repeat(2 * 1024 * 1024);
    const oversizedInput = JSON.stringify({
      preToolUse: { toolName: 'execute_command', parameters: { command: 'git status' } },
      padding: oversizedPadding,
    });
    const result = runAdapterCli(oversizedInput);
    assert.strictEqual(result.code, 0);
    const response = JSON.parse(result.stdout);
    assert.strictEqual(response.cancel, true, 'Expected fail-closed on truncated oversized input');
  })) passed++; else failed++;

  if (test('CLI: full stdout is present at exit (no truncation from exitCode-based exit)', () => {
    for (let i = 0; i < 20; i += 1) {
      const result = runAdapterCli({ preToolUse: { toolName: 'execute_command', parameters: { command: 'git status' } } });
      assert.doesNotThrow(() => JSON.parse(result.stdout), `Run ${i}: stdout was not valid JSON: ${JSON.stringify(result.stdout)}`);
    }
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
