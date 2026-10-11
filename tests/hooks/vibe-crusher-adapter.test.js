'use strict';

/**
 * Tests for scripts/hooks/vibe-crusher-adapter.js
 *
 * Mistral Vibe takes a full replacement of a tool call's arguments from
 * hook_specific_output.tool_input on stdout. The Crusher is never a security
 * boundary, so every failure here fails open: the original command runs.
 */

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'vibe-crusher-adapter.js');
const { rewriteVibeEvent } = require(adapterScript);

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

function withEgcCli(fn) {
  process.env.EGC_ASSUME_EGC_CLI = '1';
  try {
    return fn();
  } finally {
    delete process.env.EGC_ASSUME_EGC_CLI;
  }
}

function runAdapterCli(input, env = {}) {
  const result = spawnSync(process.execPath, [adapterScript], {
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

let passed = 0;
let failed = 0;
const tally = ok => { if (ok) passed++; else failed++; };

console.log('\n=== Testing vibe-crusher-adapter ===\n');

tally(test('rewriteVibeEvent routes a crushable shell command through egc run and keeps the other arguments', () => withEgcCli(() => {
  const output = rewriteVibeEvent({ tool_name: 'bash', tool_input: { command: 'git log --stat -n 300', timeout: 30 } });
  assert.deepStrictEqual(output, { hook_specific_output: { tool_input: { command: 'egc run git log --stat -n 300', timeout: 30 } } });
  assert.strictEqual(rewriteVibeEvent({ tool_name: 'git_bash', tool_input: { command: 'git log --stat -n 300' } }).hook_specific_output.tool_input.command, 'egc run git log --stat -n 300');
})));

tally(test('rewriteVibeEvent leaves a command that is not worth crushing, another tool and a malformed event alone', () => withEgcCli(() => {
  assert.strictEqual(rewriteVibeEvent({ tool_name: 'bash', tool_input: { command: 'echo hello' } }), null);
  assert.strictEqual(rewriteVibeEvent({ tool_name: 'grep', tool_input: { command: 'git log --stat -n 300' } }), null);
  assert.strictEqual(rewriteVibeEvent({ tool_name: 'bash', tool_input: { command: '' } }), null);
  assert.strictEqual(rewriteVibeEvent({ tool_name: 'bash' }), null);
  assert.strictEqual(rewriteVibeEvent(null), null);
})));

tally(test('CLI: a crushable command answers with the replacement arguments, exit 0', () => {
  const result = runAdapterCli({ tool_name: 'bash', tool_input: { command: 'git log --stat -n 300' }, cwd: '/work' });
  assert.strictEqual(result.code, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout), { hook_specific_output: { tool_input: { command: 'egc run git log --stat -n 300' } } });
}));

tally(test('CLI: a command left as it is, text that is not JSON and a payload over the cap all answer with silence, exit 0', () => {
  for (const input of [
    { tool_name: 'bash', tool_input: { command: 'echo hello' } },
    'not json at all',
    JSON.stringify({ tool_name: 'bash', tool_input: { command: `git log ${'x'.repeat(2 * 1024 * 1024)}` } }),
  ]) {
    const result = runAdapterCli(input);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(result.stdout, '');
  }
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
