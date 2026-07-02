/**
 * Tests for scripts/hooks/session-auto-learn.js via run-with-flags.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runner = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'run-with-flags.js');
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

function runHook(env = {}) {
  const rawInput = JSON.stringify({ cwd: '/tmp' });
  const result = spawnSync('node', [runner, 'session:auto-learn', 'scripts/hooks/session-auto-learn.js', 'standard,strict'], {
    input: rawInput,
    encoding: 'utf8',
    env: {
      ...process.env,
      ECC_HOOK_PROFILE: 'standard',
      EGC_GUARDIAN_CLI: fakeCli,
      ...env
    },
    timeout: 20000,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function runTests() {
  console.log('\n=== Testing session-auto-learn ===\n');

  let passed = 0;
  let failed = 0;

  if (test('runs the learn mode and passes through', () => {
    const rawInput = JSON.stringify({ cwd: '/tmp' });
    const result = runHook();
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, rawInput, 'Expected raw passthrough');
  })) passed++; else failed++;

  if (test('respects EGC_AUTO_LEARN=0', () => {
    const result = runHook({ EGC_AUTO_LEARN: '0' });
    assert.strictEqual(result.code, 0);
  })) passed++; else failed++;

  if (test('fails open when the guardian CLI is broken', () => {
    const brokenCli = path.join(os.tmpdir(), `egc-broken-cli-${Date.now()}.js`);
    fs.writeFileSync(brokenCli, 'process.exit(1);\n');
    try {
      const result = runHook({ EGC_GUARDIAN_CLI: brokenCli });
      assert.strictEqual(result.code, 0, 'Expected fail-open on broken CLI');
    } finally {
      try { fs.rmSync(brokenCli, { force: true }); } catch { /* best-effort cleanup */ }
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
