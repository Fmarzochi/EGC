/**
 * Tests that hooks fed by the shared stdin reader refuse a payload the reader
 * had to cut: blockers deny it, hooks that only annotate step aside without
 * echoing the partial text, and a throwing reader callback is surfaced.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOKS = path.join(ROOT, 'scripts', 'hooks');
const MAX_BYTES = 1024 * 1024;
const OVERSIZED = `{"tool_input":{"command":"${'a'.repeat(MAX_BYTES + 1024)}"}}`;
const TRUNCATION_NOTICE = /Hook input was cut off/;

function runHook(file, env = {}) {
  return spawnSync(process.execPath, [path.join(HOOKS, file)], {
    input: OVERSIZED,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    timeout: 20000,
  });
}

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

const BLOCKERS = [
  ['pre-bash-dev-server-block.js', {}],
  ['block-no-verify.js', {}],
  ['scrubber-hook.js', {}],
  ['gateguard-fact-force.js', {}],
  ['pre-bash-verification-gate.js', { EGC_VERIFY_GATE: 'block' }],
  ['insaits-security-wrapper.js', { EGC_ENABLE_INSAITS: '1' }],
];

const ANNOTATORS = [
  ['post-bash-pr-created.js', {}],
  ['pre-bash-tmux-reminder.js', {}],
  ['post-bash-build-complete.js', {}],
  ['crusher-hook.js', {}],
  ['pre-bash-verification-gate.js', { EGC_VERIFY_GATE: 'warn' }],
  ['insaits-security-wrapper.js', {}],
];

function runTests() {
  console.log('\n=== Testing hook handling of truncated stdin ===\n');
  let passed = 0;
  let failed = 0;
  const record = ok => (ok ? passed++ : failed++);

  for (const [file, env] of BLOCKERS) {
    record(test(`${file} denies a payload over 1 MiB`, () => {
      const result = runHook(file, env);
      assert.strictEqual(result.status, 2, result.stderr);
      assert.match(result.stderr, TRUNCATION_NOTICE);
    }));
  }

  for (const [file, env] of ANNOTATORS) {
    record(test(`${file} steps aside on a payload over 1 MiB without echoing it`, () => {
      const result = runHook(file, env);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, '');
      assert.match(result.stderr, TRUNCATION_NOTICE);
    }));
  }

  record(test('a throwing reader callback is reported and exits non-zero', () => {
    const readerPath = path.join(ROOT, 'scripts', 'lib', 'hook-stdin.js');
    const source = `require(${JSON.stringify(readerPath)}).readHookStdin(() => { throw new Error('boom'); });`;
    const result = spawnSync(process.execPath, ['-e', source], { input: '{}', encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /hook callback failed: boom/);
  }));

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
