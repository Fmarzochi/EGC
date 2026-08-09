'use strict';

/**
 * Parity test for scripts/lib/operations/index.js (issue #1235, slice 1).
 *
 * Asserts that:
 *   1. Every expected operation is present in the registry.
 *   2. Operations return plain JSON (no console writes), verified by
 *      intercepting stdout/stderr during a synchronous call.
 *   3. The registry shape is stable so slice 2 can enforce that both the
 *      CLI and the dashboard reach every operation.
 *
 * Run: node tests/lib/operations-registry.test.js
 */

const assert = require('node:assert');
const path   = require('node:path');

const {
  doctor,
  savingsLedger,
  listOperations,
  REGISTRY,
} = require('../../scripts/lib/operations/index');

// ---------------------------------------------------------------------------
// Minimal test harness (same style as the rest of the test suite)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Call fn() while capturing any writes to process.stdout / process.stderr. */
function captureConsole(fn) {
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return origWrite(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return origErrWrite(chunk, ...rest); };
  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Suite: registry shape
// ---------------------------------------------------------------------------

console.log('\noperations registry — shape\n');

const EXPECTED_OPERATIONS = ['doctor', 'install', 'savingsLedger', 'state'];

run('listOperations() returns all expected operations', () => {
  const names = listOperations();
  for (const expected of EXPECTED_OPERATIONS) {
    assert.ok(
      names.includes(expected),
      `Expected operation "${expected}" missing from registry. Got: ${names.join(', ')}`
    );
  }
});

run('REGISTRY entries each have name, fn, and async flag', () => {
  for (const entry of REGISTRY) {
    assert.ok(typeof entry.name === 'string' && entry.name.length > 0,
      `Registry entry missing name: ${JSON.stringify(entry)}`);
    assert.ok(typeof entry.fn === 'function',
      `Registry entry "${entry.name}" missing fn`);
    assert.ok(typeof entry.async === 'boolean',
      `Registry entry "${entry.name}" missing async flag`);
  }
});

run('REGISTRY names match listOperations()', () => {
  const registryNames = REGISTRY.map(e => e.name).sort();
  const listedNames   = listOperations().sort();
  assert.deepStrictEqual(registryNames, listedNames);
});

run('async flag is true only for state operation', () => {
  for (const entry of REGISTRY) {
    if (entry.name === 'state') {
      assert.strictEqual(entry.async, true, '"state" must be marked async: true');
    } else {
      assert.strictEqual(entry.async, false, `"${entry.name}" must be marked async: false`);
    }
  }
});

// ---------------------------------------------------------------------------
// Suite: doctor operation
// ---------------------------------------------------------------------------

console.log('\noperations registry — doctor\n');

run('doctor() returns a plain JSON object', () => {
  const report = doctor();
  assert.ok(report !== null && typeof report === 'object' && !Array.isArray(report),
    'doctor() must return a plain object');
});

run('doctor() result has required top-level keys', () => {
  const report = doctor();
  for (const key of ['generatedAt', 'results', 'summary']) {
    assert.ok(Object.hasOwn(report, key), `doctor() result missing key: ${key}`);
  }
});

run('doctor() result.results is an array', () => {
  const { results } = doctor();
  assert.ok(Array.isArray(results), 'doctor().results must be an array');
});

run('doctor() result.summary has numeric counters', () => {
  const { summary } = doctor();
  for (const key of ['checkedCount', 'okCount', 'errorCount', 'warningCount']) {
    assert.ok(typeof summary[key] === 'number', `doctor().summary.${key} must be a number`);
  }
});

run('doctor() does not write to console', () => {
  const lines = captureConsole(() => doctor());
  // Filter out any lines that were already being written by the harness itself
  // (e.g. test pass/fail lines). We only care that doctor() itself does not
  // write — capture is started after all harness lines so this should be clean.
  assert.strictEqual(lines.length, 0,
    `doctor() wrote to stdout/stderr: ${lines.join('')}`);
});

run('doctor() accepts empty params object', () => {
  const report = doctor({});
  assert.ok(report && typeof report === 'object');
});

// ---------------------------------------------------------------------------
// Suite: savingsLedger operation
// ---------------------------------------------------------------------------

console.log('\noperations registry — savingsLedger\n');

run('savingsLedger() returns a plain JSON object', () => {
  const result = savingsLedger();
  assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result),
    'savingsLedger() must return a plain object');
});

run('savingsLedger() result has required keys', () => {
  const result = savingsLedger();
  for (const key of ['generatedAt', 'scopes', 'sinceInstall', 'today', 'runs', 'averagePerRun']) {
    assert.ok(Object.hasOwn(result, key), `savingsLedger() result missing key: ${key}`);
  }
});

run('savingsLedger() result.runs is a number', () => {
  const { runs } = savingsLedger();
  assert.ok(typeof runs === 'number', 'savingsLedger().runs must be a number');
});

run('savingsLedger() accepts a fixed now for reproducibility', () => {
  const now = new Date('2025-01-15T12:00:00.000Z');
  const result = savingsLedger({ now });
  // generatedAt should reflect the overridden now
  assert.strictEqual(result.generatedAt, now.toISOString());
});

run('savingsLedger() does not write to console', () => {
  const lines = captureConsole(() => savingsLedger());
  assert.strictEqual(lines.length, 0,
    `savingsLedger() wrote to stdout/stderr: ${lines.join('')}`);
});

// ---------------------------------------------------------------------------
// Suite: install operation (import/shape only — no filesystem side-effects)
// ---------------------------------------------------------------------------

console.log('\noperations registry — install (import shape)\n');

run('install is exported as a function', () => {
  const { install } = require('../../scripts/lib/operations/index');
  assert.strictEqual(typeof install, 'function');
});

run('state is exported as a function', () => {
  const { state } = require('../../scripts/lib/operations/index');
  assert.strictEqual(typeof state, 'function');
});

// ---------------------------------------------------------------------------
// Suite: deleted file guard
// ---------------------------------------------------------------------------

console.log('\noperations registry — deleted file guard\n');

run('egc_dashboard_runtime.py has been deleted', () => {
  const fs = require('node:fs');
  const deadFile = path.join(__dirname, '../../scripts/lib/egc_dashboard_runtime.py');
  assert.ok(!fs.existsSync(deadFile),
    'scripts/lib/egc_dashboard_runtime.py must be deleted (dead tkinter remnant, issue #1235)');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
