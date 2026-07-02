/**
 * Tests for scripts/hooks/prompt-router.js via run-with-flags.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runner = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'run-with-flags.js');

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

function runHook(prompt, env = {}) {
  const rawInput = JSON.stringify({ prompt });
  const result = spawnSync('node', [runner, 'prompt:router', 'scripts/hooks/prompt-router.js', 'standard,strict'], {
    input: rawInput,
    encoding: 'utf8',
    env: {
      ...process.env,
      ECC_HOOK_PROFILE: 'standard',
      ...env
    },
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function runTests() {
  console.log('\n=== Testing prompt-router ===\n');

  let passed = 0;
  let failed = 0;

  if (test('injects routing context for a task-shaped prompt', () => {
    const result = runHook('review this typescript pull request for security issues');
    assert.strictEqual(result.code, 0, `Expected exit 0, got stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('=== EGC Routing ==='), `Expected routing header, got: ${result.stdout}`);
    assert.ok(result.stdout.includes('Skills:'), `Expected skills line, got: ${result.stdout}`);
  })) passed++; else failed++;

  if (test('stays silent for prompts below the minimum length', () => {
    const result = runHook('oi');
    assert.strictEqual(result.code, 0, 'Expected exit 0');
    assert.strictEqual(result.stdout, '', `Expected empty stdout, got: ${result.stdout}`);
  })) passed++; else failed++;

  if (test('never echoes the raw input JSON into context', () => {
    const result = runHook('review this typescript pull request for security issues');
    assert.ok(!result.stdout.includes('"prompt"'), `Raw input leaked into stdout: ${result.stdout}`);
  })) passed++; else failed++;

  if (test('stays silent when the router crashes', () => {
    const brokenCli = path.join(os.tmpdir(), `egc-broken-cli-${Date.now()}.js`);
    fs.writeFileSync(brokenCli, 'process.exit(1);\n');
    try {
      const result = runHook('review this typescript pull request for security issues', { EGC_GUARDIAN_CLI: brokenCli });
      assert.strictEqual(result.code, 0, 'Expected exit 0 on router crash');
      assert.strictEqual(result.stdout, '', `Expected empty stdout, got: ${result.stdout}`);
    } finally {
      try { fs.rmSync(brokenCli, { force: true }); } catch { /* best-effort cleanup */ }
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
