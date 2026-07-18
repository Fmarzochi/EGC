'use strict';
/**
 * Tests for scripts/hooks/pre-bash-crusher-rewrite.js
 *
 * Covers the fail-open contract of the Token Crusher rewrite: only simple,
 * crushable, unwrapped commands are routed through `egc run`, and every
 * uncertain case passes through untouched.
 *
 * Run with: node tests/hooks/pre-bash-crusher-rewrite.test.js
 */
const assert = require('node:assert');
const path = require('node:path');

const { run } = require(path.join(__dirname, '..', '..', 'scripts', 'hooks', 'pre-bash-crusher-rewrite.js'));

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
const runCase = (name, fn) => { if (test(name, fn)) passed++; else failed++; };

function invoke(command) {
  const out = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
  return JSON.parse(out).tool_input.command;
}

console.log('\n=== Testing pre-bash-crusher-rewrite ===\n');

process.env.EGC_ASSUME_EGC_CLI = '1';

runCase('crushable simple command is routed through egc run', () => {
  assert.strictEqual(invoke('git log --oneline -200'), 'egc run git log --oneline -200');
});

runCase('generic command passes through', () => {
  assert.strictEqual(invoke('ls -la src'), 'ls -la src');
});

runCase('pipelines and chaining pass through', () => {
  assert.strictEqual(invoke('git log | head -5'), 'git log | head -5');
  assert.strictEqual(invoke('git log && echo done'), 'git log && echo done');
  assert.strictEqual(invoke('git diff > out.txt'), 'git diff > out.txt');
});

runCase('already wrapped commands pass through', () => {
  assert.strictEqual(invoke('egc run git log'), 'egc run git log');
  assert.strictEqual(invoke('rtk git log'), 'rtk git log');
  assert.strictEqual(invoke('git log --raw'), 'git log --raw');
});

runCase('malformed input passes through unchanged', () => {
  assert.strictEqual(run('not json'), 'not json');
});

runCase('without the egc CLI nothing is rewritten', () => {
  process.env.EGC_ASSUME_EGC_CLI = '0';
  assert.strictEqual(invoke('git log --oneline -200'), 'git log --oneline -200');
  process.env.EGC_ASSUME_EGC_CLI = '1';
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
