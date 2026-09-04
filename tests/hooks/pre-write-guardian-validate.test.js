/**
 * Tests for scripts/hooks/pre-write-guardian-validate.js via run-with-flags.js
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

function runHook(filePath, env = {}, toolInput = null) {
  const rawInput = JSON.stringify({ tool_name: 'Write', tool_input: toolInput || { file_path: filePath, content: 'x' } });
  const result = spawnSync('node', [runner, 'pre:write-guardian-validate', 'scripts/hooks/pre-write-guardian-validate.js', 'minimal,standard,strict'], {
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

  // Harnesses name the write target differently; a protected path must be
  // caught whether it arrives as file_path, path (Gemini CLI) or TargetFile
  // (Antigravity).
  function runHookField(field, filePath) {
    const rawInput = JSON.stringify({ tool_name: 'Write', tool_input: { [field]: filePath, content: 'x' } });
    const result = spawnSync('node', [runner, 'pre:write-guardian-validate', 'scripts/hooks/pre-write-guardian-validate.js', 'minimal,standard,strict'], {
      input: rawInput,
      encoding: 'utf8',
      env: { ...process.env, ECC_HOOK_PROFILE: 'standard', EGC_GUARDIAN_CLI: fakeCli },
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return Number.isInteger(result.status) ? result.status : 1;
  }

  if (test('blocks a protected write arriving via the path field', () => {
    const code = runHookField('path', path.join(os.homedir(), '.ssh', 'id_rsa'));
    assert.strictEqual(code, 2, 'Expected block when the target arrives as path');
  })) passed++; else failed++;

  if (test('blocks a protected write arriving via the TargetFile field', () => {
    const code = runHookField('TargetFile', path.join(os.homedir(), '.aws', 'credentials'));
    assert.strictEqual(code, 2, 'Expected block when the target arrives as TargetFile');
  })) passed++; else failed++;

  if (test('fails open silently when the validator crashes', () => {
    const brokenCli = path.join(os.tmpdir(), `egc-broken-cli-${Date.now()}.js`);
    fs.writeFileSync(brokenCli, 'process.exit(1);\n');
    try {
      const result = runHook(path.join(os.homedir(), '.ssh', 'id_rsa'), { EGC_GUARDIAN_CLI: brokenCli });
      assert.strictEqual(result.code, 0, 'Expected fail-open on validator crash');
      assert.strictEqual(result.stderr, '', `Expected silent fail-open, got: ${result.stderr}`);
    } finally {
      try { fs.rmSync(brokenCli, { force: true }); } catch { /* best-effort cleanup */ }
    }
  })) passed++; else failed++;

  if (test('blocks writing a shell script whose line runs a denied command', () => {
    const result = runHook('/tmp/egc-script.sh', {}, { file_path: '/tmp/egc-script.sh', content: '#!/bin/bash\nset -e\necho start\nrm -rf /tmp/egc-victim\n' });
    assert.strictEqual(result.code, 2, result.stderr);
    assert.ok(result.stderr.includes('line 4'), result.stderr);
  })) passed++; else failed++;

  if (test('blocks an edit that inserts a denied command into a script', () => {
    const result = runHook('/tmp/deploy.sh', {}, { file_path: '/tmp/deploy.sh', old_string: 'echo ok', new_string: 'echo ok && mv /etc/hosts /tmp/hosts' });
    assert.strictEqual(result.code, 2, result.stderr);
  })) passed++; else failed++;

  if (test('allows a script whose lines are benign or merely outside the allowlist', () => {
    const result = runHook('/tmp/build.sh', {}, { file_path: '/tmp/build.sh', content: '#!/usr/bin/env bash\ncargo build --release\nnpm test\necho done\n' });
    assert.strictEqual(result.code, 0, result.stderr);
  })) passed++; else failed++;

  if (test('does not treat non-script content as commands', () => {
    const result = runHook('/tmp/notes.md', {}, { file_path: '/tmp/notes.md', content: 'rm -rf / is a dangerous command, never run it\n' });
    assert.strictEqual(result.code, 0, result.stderr);
  })) passed++; else failed++;

  if (test('passes through input without a file path', () => {
    const rawInput = JSON.stringify({ tool_name: 'Write', tool_input: {} });
    const result = spawnSync('node', [runner, 'pre:write-guardian-validate', 'scripts/hooks/pre-write-guardian-validate.js', 'minimal,standard,strict'], {
      input: rawInput,
      encoding: 'utf8',
      env: { ...process.env, ECC_HOOK_PROFILE: 'standard', EGC_GUARDIAN_CLI: fakeCli },
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
