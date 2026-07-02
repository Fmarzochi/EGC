/**
 * Tests for scripts/hooks/pre-write-guardian-validate.js via run-with-flags.js
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

function runHook(filePath, env = {}) {
  const rawInput = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' } });
  const result = spawnSync('node', [runner, 'pre:write-guardian-validate', 'scripts/hooks/pre-write-guardian-validate.js', 'minimal,standard,strict'], {
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
  console.log('\n=== Testing pre-write-guardian-validate ===\n');

  let passed = 0;
  let failed = 0;

  if (test('blocks writes to protected credential paths', () => {
    const result = runHook(path.join(os.homedir(), '.ssh', 'id_rsa'));
    assert.strictEqual(result.code, 2, 'Expected protected write to be blocked');
    assert.ok(result.stderr.includes('protected'), `Expected reason, got: ${result.stderr}`);
  })) passed++; else failed++;

  if (test('blocks writes to key files by pattern', () => {
    const result = runHook('/tmp/deploy.pem');
    assert.strictEqual(result.code, 2, 'Expected key file write to be blocked');
  })) passed++; else failed++;

  if (test('allows writes to normal project paths', () => {
    const result = runHook('/tmp/egc-test-output.txt');
    assert.strictEqual(result.code, 0, `Expected allow, got: ${result.stderr}`);
  })) passed++; else failed++;

  if (test('fails open with a warning when the validator crashes', () => {
    const brokenCli = path.join(os.tmpdir(), `egc-broken-cli-${Date.now()}.js`);
    fs.writeFileSync(brokenCli, 'process.exit(1);\n');
    try {
      const result = runHook(path.join(os.homedir(), '.ssh', 'id_rsa'), { EGC_GUARDIAN_CLI: brokenCli });
      assert.strictEqual(result.code, 0, 'Expected fail-open on validator crash');
      assert.ok(result.stderr.includes('validator unavailable'), `Expected warning, got: ${result.stderr}`);
    } finally {
      try { fs.rmSync(brokenCli, { force: true }); } catch { /* best-effort cleanup */ }
    }
  })) passed++; else failed++;

  if (test('passes through input without a file path', () => {
    const rawInput = JSON.stringify({ tool_name: 'Write', tool_input: {} });
    const result = spawnSync('node', [runner, 'pre:write-guardian-validate', 'scripts/hooks/pre-write-guardian-validate.js', 'minimal,standard,strict'], {
      input: rawInput,
      encoding: 'utf8',
      env: { ...process.env, ECC_HOOK_PROFILE: 'standard' },
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.strictEqual(result.status, 0, 'Expected pass for missing file path');
    assert.strictEqual(result.stdout, rawInput, 'Expected raw passthrough');
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
