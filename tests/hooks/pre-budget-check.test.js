'use strict';

/**
 * Tests for scripts/hooks/pre-budget-check.js (#1704): the budget warning
 * travels in the hook result, the channel the runner and the dispatcher
 * forward, instead of a direct console.error that bypasses them.
 *
 * Run with: node tests/hooks/pre-budget-check.test.js
 */

const assert = require('node:assert');

// The budget tracker reads files under the EGC home; the hook is exercised
// against a stub so the test owns what the budget says.
const trackerPath = require.resolve('../../scripts/lib/budget-tracker');
const budget = { block: false, warn: false, reason: '' };
require.cache[trackerPath] = {
  id: trackerPath,
  filename: trackerPath,
  loaded: true,
  exports: { checkBudget: () => ({ ...budget }), recordToolCall() {} },
};
const { run } = require('../../scripts/hooks/pre-budget-check');

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function countingConsoleError(fn) {
  const original = console.error;
  let calls = 0;
  console.error = () => { calls++; };
  try {
    return { result: fn(), calls };
  } finally {
    console.error = original;
  }
}

let passed = 0;
let failed = 0;
const tally = ok => { if (ok) passed++; else failed++; };

console.log('\n=== Testing pre-budget-check.js ===\n');

tally(test('a warning comes back in the hook result and is not written to the console', () => {
  Object.assign(budget, { block: false, warn: true, reason: '80% of the budget used' });
  const { result, calls } = countingConsoleError(() => run('{"tool_input":{"command":"ls"}}'));
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.stderr, '[EGC Budget Guardian] WARNING: 80% of the budget used\n');
  assert.strictEqual(calls, 0, 'nothing bypasses the hook output channel');
}));

tally(test('a block still exits 2 with its reason', () => {
  Object.assign(budget, { block: true, warn: false, reason: 'budget exhausted' });
  const result = run('{"tool_input":{"command":"ls"}}');
  assert.strictEqual(result.exitCode, 2);
  assert.strictEqual(result.stderr, '[EGC Budget Guardian] BLOCKED: budget exhausted\n');
}));

tally(test('a call inside the budget answers with a plain exit 0', () => {
  Object.assign(budget, { block: false, warn: false, reason: '' });
  assert.deepStrictEqual(run('{}'), { exitCode: 0 });
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
