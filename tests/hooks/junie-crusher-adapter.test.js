/**
 * Tests for scripts/hooks/junie-crusher-adapter.js
 *
 * Junie's PreToolUse input already matches Claude Code's own shape, so this
 * only exercises the flat {decision, updatedInput} output translation and
 * the exitCode-vs-forced-exit fix (cubic-dev-ai finding, PR #1081). The
 * Crusher is never a security boundary (unlike junie-guardian-adapter.js),
 * so every failure mode here fails OPEN, never closed.
 */

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'junie-crusher-adapter.js');
const { computeRewrittenCommand } = require(adapterScript);

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
  console.log('\n=== Testing junie-crusher-adapter ===\n');

  let passed = 0;
  let failed = 0;

  if (test('computeRewrittenCommand rewrites a crushable command', () => {
    process.env.EGC_ASSUME_EGC_CLI = '1';
    try {
      assert.strictEqual(
        computeRewrittenCommand({ tool_name: 'Bash', tool_input: { command: 'git log --stat -n 300' } }),
        'egc run git log --stat -n 300'
      );
    } finally {
      delete process.env.EGC_ASSUME_EGC_CLI;
    }
  })) passed++; else failed++;

  if (test('computeRewrittenCommand returns null for a non-crushable command', () => {
    process.env.EGC_ASSUME_EGC_CLI = '1';
    try {
      assert.strictEqual(computeRewrittenCommand({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }), null);
    } finally {
      delete process.env.EGC_ASSUME_EGC_CLI;
    }
  })) passed++; else failed++;

  if (test('computeRewrittenCommand returns null when there is no command', () => {
    assert.strictEqual(computeRewrittenCommand({ tool_name: 'Bash', tool_input: {} }), null);
  })) passed++; else failed++;

  if (test('computeRewrittenCommand returns null (does not throw) for a non-object event', () => {
    assert.strictEqual(computeRewrittenCommand(null), null);
    assert.strictEqual(computeRewrittenCommand('a string'), null);
    assert.strictEqual(computeRewrittenCommand(42), null);
  })) passed++; else failed++;

  if (test('CLI: rewrites a crushable command with updatedInput.command', () => {
    const result = runAdapterCli({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git log --stat -n 300' } });
    assert.strictEqual(result.code, 0);
    const response = JSON.parse(result.stdout);
    assert.strictEqual(response.decision, 'allow');
    assert.strictEqual(response.updatedInput.command, 'egc run git log --stat -n 300');
  })) passed++; else failed++;

  if (test('CLI: a trivial command allows with no updatedInput (no false positive)', () => {
    const result = runAdapterCli({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: 'allow' });
  })) passed++; else failed++;

  if (test('CLI: malformed stdin JSON fails OPEN (allow)', () => {
    const result = runAdapterCli('not json');
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: 'allow' });
  })) passed++; else failed++;

  if (test('CLI: a truncated oversized payload fails OPEN (allow), unlike the Guardian adapter\'s fail-closed', () => {
    const oversizedPadding = 'x'.repeat(2 * 1024 * 1024);
    const oversizedInput = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git log --stat -n 300' },
      padding: oversizedPadding,
    });
    const result = runAdapterCli(oversizedInput);
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: 'allow' });
  })) passed++; else failed++;

  if (test('CLI: full stdout is present at exit (no truncation from exitCode-based exit)', () => {
    // Regression guard for the cubic-dev-ai finding (PR #1081): a forced
    // process.exit() right after stdout.write() can race the pipe flush on
    // POSIX, potentially delivering a truncated response that Junie would
    // then ignore (falling back to the original, un-crushed command).
    for (let i = 0; i < 20; i += 1) {
      const result = runAdapterCli({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git log --stat -n 300' } });
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, `Run ${i}: stdout was not valid JSON: ${JSON.stringify(result.stdout)}`);
      assert.strictEqual(parsed.updatedInput.command, 'egc run git log --stat -n 300', `Run ${i}: incomplete updatedInput`);
    }
  })) passed++; else failed++;

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
