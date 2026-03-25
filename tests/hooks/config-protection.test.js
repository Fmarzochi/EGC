/**
 * Tests for scripts/hooks/config-protection.js via run-with-flags.js
 */

const assert = require('assert');
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

function runHook(input, env = {}) {
  const rawInput = typeof input === 'string' ? input : JSON.stringify(input);
  const result = spawnSync('node', [runner, 'pre:config-protection', 'scripts/hooks/config-protection.js', 'standard,strict'], {
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
  console.log('\n=== Testing config-protection ===\n');

  let passed = 0;
  let failed = 0;

  if (test('blocks protected config file edits through run-with-flags', () => {
    const input = {
      tool_name: 'Write',
      tool_input: {
        file_path: '.eslintrc.js',
        content: 'module.exports = {};'
      }
    };

    const result = runHook(input);
    assert.strictEqual(result.code, 2, 'Expected protected config edit to be blocked');
    assert.strictEqual(result.stdout, '', 'Blocked hook should not echo raw input');
    assert.ok(result.stderr.includes('BLOCKED: Modifying .eslintrc.js is not allowed.'), `Expected block message, got: ${result.stderr}`);
  })) passed++; else failed++;

  if (test('passes through safe file edits unchanged', () => {
    const input = {
      tool_name: 'Write',
      tool_input: {
        file_path: 'src/index.js',
        content: 'console.log("ok");'
      }
    };

    const rawInput = JSON.stringify(input);
    const result = runHook(input);
    assert.strictEqual(result.code, 0, 'Expected safe file edit to pass');
    assert.strictEqual(result.stdout, rawInput, 'Expected exact raw JSON passthrough');
    assert.strictEqual(result.stderr, '', 'Expected no stderr for safe edits');
  })) passed++; else failed++;

  if (test('blocks truncated protected config payloads instead of failing open', () => {
    const rawInput = JSON.stringify({
      tool_name: 'Write',
      tool_input: {
        file_path: '.eslintrc.js',
        content: 'x'.repeat(1024 * 1024 + 2048)
      }
    });

    const result = runHook(rawInput);
    assert.strictEqual(result.code, 2, 'Expected truncated protected payload to be blocked');
    assert.strictEqual(result.stdout, '', 'Blocked truncated payload should not echo raw input');
    assert.ok(result.stderr.includes('Hook input exceeded 1048576 bytes'), `Expected size warning, got: ${result.stderr}`);
    assert.ok(result.stderr.includes('truncated payload'), `Expected truncated payload warning, got: ${result.stderr}`);
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
