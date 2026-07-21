'use strict';
/**
 * Tests for scripts/crush-run.js --shell mode.
 *
 * The --shell mode runs the joined command through bash so pipelines and
 * compound commands keep exact semantics while their output still gets crushed.
 * These tests verify semantics, exit-code propagation, and that small output is
 * left untouched.
 *
 * Run with: node tests/crush-run-shell.test.js
 */
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUN = path.join(__dirname, '..', 'scripts', 'crush-run.js');

function egcRun(args) {
  return spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8' });
}

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

console.log('\n=== Testing crush-run --shell ===\n');

runCase('--shell runs a pipeline with exact bash semantics', () => {
  const r = egcRun(['--shell', 'printf "a\\nb\\nc\\n" | grep b']);
  assert.strictEqual(r.stdout.trim(), 'b');
  assert.strictEqual(r.status, 0);
});

runCase('--shell propagates a failing exit code', () => {
  const r = egcRun(['--shell', 'exit 3']);
  assert.strictEqual(r.status, 3);
});

runCase('--shell chaining keeps both sides', () => {
  const r = egcRun(['--shell', 'echo one && echo two']);
  assert.strictEqual(r.stdout.trim().split('\n').join(','), 'one,two');
  assert.strictEqual(r.status, 0);
});

runCase('small output passes through uncrushed (no marker)', () => {
  const r = egcRun(['--shell', 'echo hi']);
  assert.strictEqual(r.stdout.trim(), 'hi');
  assert.ok(!r.stdout.includes('[egc-crusher]'));
});

runCase('non-shell mode still runs a plain command', () => {
  const r = egcRun(['git', '--version']);
  assert.ok(/git version/.test(r.stdout));
  assert.strictEqual(r.status, 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
