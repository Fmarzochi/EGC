/**
 * Shared test harness for the per-host Guardian adapter scripts
 * (amazonq/goose/openhands-guardian-adapter.js). Each of those adapters
 * translates a structurally similar but field-name-different stdin
 * envelope into the same Guardian input shape and the same plain
 * exit-code contract -- this harness runs the same suite of cases against
 * any of them, parameterized by how each host's envelope is built.
 */

'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

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

function runGuardianAdapterTests({
  suiteLabel,
  adapterScript,
  buildGuardianInput,
  shellToolName,
  nonShellToolName,
  buildEvent,
  cwdKey,
}) {
  console.log(`\n=== Testing ${suiteLabel} ===\n`);

  let passed = 0;
  let failed = 0;
  const record = ok => { if (ok) passed++; else failed++; };

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

  record(test(`maps a ${shellToolName} event to a Guardian Bash input`, () => {
    const mapped = buildGuardianInput(buildEvent(shellToolName, { command: 'echo hi' }, { [cwdKey]: '/Users/example/project' }));
    assert.deepStrictEqual(mapped, { tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: '/Users/example/project' });
  }));

  record(test(`omits cwd when ${cwdKey} is not a string`, () => {
    const mapped = buildGuardianInput(buildEvent(shellToolName, { command: 'echo hi' }, {}));
    assert.strictEqual('cwd' in mapped, false);
  }));

  record(test(`returns null for a non-${shellToolName} tool_name`, () => {
    assert.strictEqual(buildGuardianInput(buildEvent(nonShellToolName, {}, {})), null);
  }));

  record(test(`returns null for a ${shellToolName} event with no tool_input.command`, () => {
    assert.strictEqual(buildGuardianInput(buildEvent(shellToolName, {}, {})), null);
  }));

  record(test('returns null (does not throw) for a non-object event, e.g. valid JSON "null"', () => {
    assert.strictEqual(buildGuardianInput(null), null);
    assert.strictEqual(buildGuardianInput('a string'), null);
    assert.strictEqual(buildGuardianInput(42), null);
  }));

  record(test('CLI: a valid JSON "null" payload allows (exit 0) instead of crashing', () => {
    const result = runAdapterCli('null');
    assert.strictEqual(result.code, 0);
  }));

  record(test('CLI: blocks a destructive command with exit 2 and a reason on stderr', () => {
    const result = runAdapterCli(buildEvent(shellToolName, { command: 'rm -rf /' }, {}));
    assert.strictEqual(result.code, 2);
    assert.ok(result.stderr.length > 0, 'expected a reason on stderr');
  }));

  record(test('CLI: allows a safe allowlisted command (exit 0)', () => {
    const result = runAdapterCli(buildEvent(shellToolName, { command: 'git status' }, {}));
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stderr, '');
  }));

  record(test(`CLI: non-${shellToolName} tool_name exits 0 with no output`, () => {
    const result = runAdapterCli(buildEvent(nonShellToolName, { path: '/tmp/some-file.js' }, {}));
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(result.stderr, '');
  }));

  record(test('CLI: malformed (non-truncated) stdin JSON fails open (exit 0)', () => {
    const result = runAdapterCli('not json');
    assert.strictEqual(result.code, 0);
  }));

  record(test('CLI: an oversized payload that gets truncated into invalid JSON fails CLOSED (exit 2), not open', () => {
    const oversizedPadding = 'x'.repeat(2 * 1024 * 1024);
    const oversizedInput = JSON.stringify(buildEvent(shellToolName, { command: 'git status', padding: oversizedPadding }, {}));
    const result = runAdapterCli(oversizedInput);
    assert.strictEqual(result.code, 2, `Expected fail-closed on truncated oversized input, got exit ${result.code}`);
  }));

  record(test('CLI: full stderr reason is present at exit (no truncation from exitCode-based exit)', () => {
    // Regression guard for the race fixed in runPlainExitCodeGuardianAdapter
    // (EGC-539 audit, Finding A): the shared helper used to call
    // process.exit(2) right after stderr.write(), which can race the pipe
    // flush on POSIX and truncate the diagnostic message before the host
    // reads it. Now uses process.exitCode, the same fix already applied to
    // the JSON-envelope contract's Cline/Junie/Cursor adapters.
    for (let i = 0; i < 20; i += 1) {
      const result = runAdapterCli(buildEvent(shellToolName, { command: 'rm -rf /' }, {}));
      assert.strictEqual(result.code, 2, `Run ${i}: expected exit 2`);
      assert.ok(result.stderr.length > 0, `Run ${i}: expected non-empty stderr`);
    }
  }));

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

module.exports = { runGuardianAdapterTests };
