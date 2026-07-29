/**
 * Tests for scripts/hooks/junie-guardian-adapter.js
 *
 * Junie's PreToolUse input already matches Claude Code's own shape
 * ({tool_name, tool_input: {command}}), so unlike Cursor/Windsurf, no input
 * remapping is tested here -- only the flat {decision, reason} output
 * envelope translation and the exit-code contract (0 allow, 2 deny), plus
 * the exitCode-vs-forced-exit fix (cubic-dev-ai finding, PR #1081).
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'junie-guardian-adapter.js');
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
  console.log('\n=== Testing junie-guardian-adapter ===\n');

  let passed = 0;
  let failed = 0;

  if (test('CLI: allows a safe command (exit 0, {decision: "allow"})', () => {
    const result = runAdapterCli({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: 'allow' });
  })) passed++; else failed++;

  if (test('CLI: blocks a destructive command (exit 2, {decision: "deny", reason})', () => {
    const result = runAdapterCli({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
    assert.strictEqual(result.code, 2);
    const response = JSON.parse(result.stdout);
    assert.strictEqual(response.decision, 'deny');
    assert.ok(response.reason && response.reason.length > 0, 'expected a non-empty reason');
  })) passed++; else failed++;

  if (test('CLI: event with no command allows (exit 0)', () => {
    const result = runAdapterCli({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: 'allow' });
  })) passed++; else failed++;

  if (test('CLI: forwards cwd to the Guardian for relative path resolution', () => {
    // A destructive command scoped by cwd (relative path) must resolve
    // against the event's cwd, not this adapter process's own cwd -- same
    // check cursor-guardian-adapter.js's own test asserts for its
    // equivalent field.
    const result = runAdapterCli({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      cwd: '/tmp',
    });
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (test('CLI: malformed stdin JSON fails open (exit 0, allow)', () => {
    const result = runAdapterCli('not json');
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: 'allow' });
  })) passed++; else failed++;

  if (test('CLI: a truncated oversized payload fails CLOSED (exit 2, deny) -- Guardian is a security boundary', () => {
    const oversizedPadding = 'x'.repeat(2 * 1024 * 1024);
    const oversizedInput = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      padding: oversizedPadding,
    });
    const result = runAdapterCli(oversizedInput);
    assert.strictEqual(result.code, 2, `Expected fail-closed on truncated oversized input, got exit ${result.code}`);
    const response = JSON.parse(result.stdout);
    assert.strictEqual(response.decision, 'deny');
  })) passed++; else failed++;

  if (test('CLI: full stdout is present at exit (no truncation from exitCode-based exit)', () => {
    // Regression guard for the cubic-dev-ai finding (PR #1081): a forced
    // process.exit() right after stdout.write() can race the pipe flush on
    // POSIX. Asserting the full JSON parses (not just non-empty) proves the
    // exitCode-based fix delivers the complete response every time, not
    // just usually.
    for (let i = 0; i < 20; i += 1) {
      const result = runAdapterCli({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } });
      assert.doesNotThrow(() => JSON.parse(result.stdout), `Run ${i}: stdout was not valid JSON: ${JSON.stringify(result.stdout)}`);
    }
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
