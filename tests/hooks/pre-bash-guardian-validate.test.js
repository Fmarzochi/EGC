/**
 * Tests for scripts/hooks/pre-bash-guardian-validate.js via run-with-flags.js
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

function runHook(command, env = {}) {
  const rawInput = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const result = spawnSync('node', [runner, 'pre:bash:guardian-validate', 'scripts/hooks/pre-bash-guardian-validate.js', 'minimal,standard,strict'], {
    input: rawInput,
    encoding: 'utf8',
    env: {
      ...process.env,
      ECC_HOOK_PROFILE: 'standard',
      EGC_GUARDIAN_CLI: fakeCli,
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
  console.log('\n=== Testing pre-bash-guardian-validate ===\n');

  let passed = 0;
  let failed = 0;

  if (test('allows a safe allowlisted command', () => {
    const result = runHook('git status');
    assert.strictEqual(result.code, 0, `Expected allow, got: ${result.stderr}`);
  })) passed++; else failed++;

  if (test('allows a compound command of safe segments', () => {
    const result = runHook('cd /tmp && npm run build');
    assert.strictEqual(result.code, 0, `Expected allow, got: ${result.stderr}`);
  })) passed++; else failed++;

  if (test('allows a non-allowlisted command (advisory, never blocks)', () => {
    const result = runHook('python3 script.py');
    assert.strictEqual(result.code, 0, `Expected allow, got: ${result.stderr}`);
  })) passed++; else failed++;

  if (test('blocks a destructive command', () => {
    const result = runHook('rm -rf /');
    assert.strictEqual(result.code, 2, 'Expected rm to be blocked');
    assert.ok(result.stderr.includes('destructive command'), `Expected reason, got: ${result.stderr}`);
  })) passed++; else failed++;

  if (test('blocks a destructive command hidden behind chaining', () => {
    const result = runHook('git status && rm -rf ~');
    assert.strictEqual(result.code, 2, 'Expected chained rm to be blocked');
  })) passed++; else failed++;

  if (test('blocks a destructive command behind sudo', () => {
    const result = runHook('sudo rm -rf /etc');
    assert.strictEqual(result.code, 2, 'Expected sudo rm to be blocked');
  })) passed++; else failed++;

  if (test('blocks reads of protected paths', () => {
    const result = runHook('cat ~/.ssh/id_rsa');
    assert.strictEqual(result.code, 2, 'Expected protected path read to be blocked');
    assert.ok(result.stderr.includes('protected path'), `Expected reason, got: ${result.stderr}`);
  })) passed++; else failed++;

  if (test('blocks git force-push', () => {
    const result = runHook('git push --force origin main');
    assert.strictEqual(result.code, 2, 'Expected force-push to be blocked');
  })) passed++; else failed++;

  if (test('fails open silently when the validator crashes', () => {
    const brokenCli = path.join(os.tmpdir(), `egc-broken-cli-${Date.now()}.js`);
    fs.writeFileSync(brokenCli, 'process.exit(1);\n');
    try {
      const result = runHook('rm -rf /', { EGC_GUARDIAN_CLI: brokenCli });
      assert.strictEqual(result.code, 0, 'Expected fail-open on validator crash');
      assert.strictEqual(result.stderr, '', `Expected silent fail-open, got: ${result.stderr}`);
    } finally {
      try { fs.rmSync(brokenCli, { force: true }); } catch { /* best-effort cleanup */ }
    }
  })) passed++; else failed++;

  if (test('passes through input without a command field', () => {
    const rawInput = JSON.stringify({ tool_name: 'Bash', tool_input: {} });
    const result = spawnSync('node', [runner, 'pre:bash:guardian-validate', 'scripts/hooks/pre-bash-guardian-validate.js', 'minimal,standard,strict'], {
      input: rawInput,
      encoding: 'utf8',
      env: { ...process.env, ECC_HOOK_PROFILE: 'standard', EGC_GUARDIAN_CLI: fakeCli },
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.strictEqual(result.status, 0, 'Expected pass for missing command');
    assert.strictEqual(result.stdout, rawInput, 'Expected raw passthrough');
  })) passed++; else failed++;

  if (test('blocks a destructive command hidden inside a $(...) command substitution', () => {
    const result = runHook('echo $(rm -rf /)');
    assert.strictEqual(result.code, 2, 'Expected the substitution body to be extracted and blocked');
  })) passed++; else failed++;

  if (test('blocks a destructive command hidden inside a backtick substitution', () => {
    const result = runHook('echo `rm -rf /`');
    assert.strictEqual(result.code, 2, 'Expected the substitution body to be extracted and blocked');
  })) passed++; else failed++;

  if (test('allows a benign command with a $(...) substitution that resolves to nothing dangerous', () => {
    const result = runHook('echo $(date)');
    assert.strictEqual(result.code, 0, `Expected allow, got: ${result.stderr}`);
  })) passed++; else failed++;

  if (test('runs standalone via node (require.main === module stdin path), not just through run-with-flags', () => {
    const hookPath = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'pre-bash-guardian-validate.js');
    const rawInput = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } });
    const result = spawnSync('node', [hookPath], {
      input: rawInput,
      encoding: 'utf8',
      env: { ...process.env, EGC_GUARDIAN_CLI: fakeCli },
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.strictEqual(result.status, 0, `Expected allow, got: ${result.stderr}`);
    assert.strictEqual(result.stdout, rawInput, 'Expected raw passthrough on stdout');
  })) passed++; else failed++;

  if (test('runs standalone via node and blocks + writes stderr on a destructive command', () => {
    const hookPath = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'pre-bash-guardian-validate.js');
    const rawInput = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
    const result = spawnSync('node', [hookPath], {
      input: rawInput,
      encoding: 'utf8',
      env: { ...process.env, EGC_GUARDIAN_CLI: fakeCli },
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.strictEqual(result.status, 2, 'Expected block exit code');
    assert.ok(result.stderr.includes('destructive command'), `Expected reason on stderr, got: ${result.stderr}`);
  })) passed++; else failed++;

  if (test('handles malformed JSON input without crashing (fails open)', () => {
    const result = spawnSync('node', [runner, 'pre:bash:guardian-validate', 'scripts/hooks/pre-bash-guardian-validate.js', 'minimal,standard,strict'], {
      input: '{not valid json',
      encoding: 'utf8',
      env: { ...process.env, ECC_HOOK_PROFILE: 'standard', EGC_GUARDIAN_CLI: fakeCli },
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.strictEqual(result.status, 0, 'Expected fail-open on malformed JSON input');
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
