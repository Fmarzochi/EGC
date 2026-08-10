'use strict';

/**
 * Parity test for scripts/lib/operations/index.js (issue #1235, slice 1).
 *
 * Asserts that:
 *   1. Every expected operation is present in the registry.
 *   2. Synchronous operations return plain JSON (no console writes).
 *   3. state() returns plain JSON-serializable data (not a live store object).
 *   4. The registry shape is stable so slice 2 can enforce both doors reach
 *      every operation.
 *
 * Run: node tests/lib/operations-registry.test.js
 */

const assert = require('node:assert');
const path   = require('node:path');
const os     = require('node:os');
const fs     = require('node:fs');

const {
  doctor,
  savingsLedger,
  state,
  install,
  listOperations,
  REGISTRY,
} = require('../../scripts/lib/operations/index');

// ---------------------------------------------------------------------------
// Async-aware test harness (CodeRabbit finding: run() must handle Promises)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const results = [];

async function run(name, fn) {
  try {
    const ret = fn();
    // If fn returns a Promise, await it so rejections count as failures.
    if (ret && typeof ret.then === 'function') {
      await ret;
    }
    results.push({ name, ok: true });
    passed++;
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Console-capture helper
// ---------------------------------------------------------------------------

/**
 * Call fn() while capturing any writes to process.stdout / process.stderr.
 * Supports both sync and async fn (CodeRabbit finding).
 */
async function captureConsole(fn) {
  const lines = [];
  const origWrite    = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return origWrite(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return origErrWrite(chunk, ...rest); };
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') await ret;
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// All tests
// ---------------------------------------------------------------------------

async function main() {

  // ── Registry shape ────────────────────────────────────────────────────────

  await run('listOperations() returns all expected operations', () => {
    const names = listOperations();
    for (const expected of ['doctor', 'install', 'savingsLedger', 'state']) {
      assert.ok(names.includes(expected),
        `Expected operation "${expected}" missing. Got: ${names.join(', ')}`);
    }
  });

  await run('REGISTRY entries each have name, fn, and async flag', () => {
    for (const entry of REGISTRY) {
      assert.ok(typeof entry.name === 'string' && entry.name.length > 0,
        `Registry entry missing name: ${JSON.stringify(entry)}`);
      assert.ok(typeof entry.fn === 'function',
        `Registry entry "${entry.name}" missing fn`);
      assert.ok(typeof entry.async === 'boolean',
        `Registry entry "${entry.name}" missing async flag`);
    }
  });

  await run('REGISTRY names match listOperations()', () => {
    assert.deepStrictEqual(
      REGISTRY.map(e => e.name).sort(),
      listOperations().sort()
    );
  });

  await run('async flag is true for install and state, false for doctor and savingsLedger', () => {
    const asyncOps = ['install', 'state'];
    const syncOps  = ['doctor', 'savingsLedger'];
    for (const entry of REGISTRY) {
      if (asyncOps.includes(entry.name)) {
        assert.strictEqual(entry.async, true, `"${entry.name}" must be marked async: true`);
      } else if (syncOps.includes(entry.name)) {
        assert.strictEqual(entry.async, false, `"${entry.name}" must be marked async: false`);
      }
    }
  });

  await run('createQueryApi is NOT re-exported (P3: low-level internal)', () => {
    const ops = require('../../scripts/lib/operations/index');
    assert.ok(!Object.hasOwn(ops, 'createQueryApi'),
      'createQueryApi must not be in the public operations surface');
  });

  // ── Input validation (CodeRabbit finding) ────────────────────────────────

  await run('doctor(null) does not throw TypeError', () => {
    const result = doctor(null);
    assert.ok(result && typeof result === 'object');
  });

  await run('doctor(undefined) does not throw TypeError', () => {
    const result = doctor(undefined);
    assert.ok(result && typeof result === 'object');
  });

  await run('savingsLedger(null) does not throw TypeError', () => {
    const result = savingsLedger(null);
    assert.ok(result && typeof result === 'object');
  });

  await run('install is exported as an async function', () => {
    assert.strictEqual(typeof install, 'function');
    assert.ok(
      install.constructor.name === 'AsyncFunction',
      'install must be an async function'
    );
  });

  await run('install(request, { dryRun: true }) returns plan without applying', async () => {
    // mode:'legacy' with a valid target and sourceRoot so createInstallPlanFromRequest
    // succeeds. dryRun:true short-circuits before any filesystem writes.
    const stubRequest = {
      mode: 'legacy',
      target: 'cursor',
      languages: ['javascript'],
    };
    const result = await install(stubRequest, {
      dryRun: true,
      sourceRoot: path.join(__dirname, '../..'),
    });
    assert.ok(Object.hasOwn(result, 'plan'),    'dryRun result must have plan');
    assert.strictEqual(result.applied, null,    'dryRun result.applied must be null');
    assert.deepStrictEqual(result.warnings, [], 'dryRun result.warnings must be []');
    // syncPromise must not appear in JSON output (non-enumerable)
    assert.ok(!Object.keys(result).includes('syncPromise'), 'syncPromise must not be enumerable');
  });

  // ── doctor() ─────────────────────────────────────────────────────────────

  await run('doctor() returns a plain JSON object', () => {
    const report = doctor();
    assert.ok(report !== null && typeof report === 'object' && !Array.isArray(report));
  });

  await run('doctor() result survives JSON round-trip', () => {
    const report = doctor();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(report)), report);
  });

  await run('doctor() result has required top-level keys', () => {
    const report = doctor();
    for (const key of ['generatedAt', 'results', 'summary']) {
      assert.ok(Object.hasOwn(report, key), `doctor() result missing key: ${key}`);
    }
  });

  await run('doctor() result.summary has numeric counters', () => {
    const { summary } = doctor();
    for (const key of ['checkedCount', 'okCount', 'errorCount', 'warningCount']) {
      assert.ok(typeof summary[key] === 'number', `summary.${key} must be a number`);
    }
  });

  await run('doctor() does not write to console', async () => {
    const lines = await captureConsole(() => doctor());
    assert.strictEqual(lines.length, 0,
      `doctor() wrote to stdout/stderr: ${lines.join('')}`);
  });

  // ── savingsLedger() ───────────────────────────────────────────────────────

  await run('savingsLedger() returns a plain JSON object', () => {
    const result = savingsLedger();
    assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result));
  });

  await run('savingsLedger() result survives JSON round-trip', () => {
    const result = savingsLedger();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), result);
  });

  await run('savingsLedger() result.runs is a number', () => {
    const { runs } = savingsLedger();
    assert.ok(typeof runs === 'number');
  });

  await run('savingsLedger() accepts a fixed now for reproducibility', () => {
    const now = new Date('2025-01-15T12:00:00.000Z');
    const result = savingsLedger({ now });
    assert.strictEqual(result.generatedAt, now.toISOString());
  });

  await run('savingsLedger() does not write to console', async () => {
    const lines = await captureConsole(() => savingsLedger());
    assert.strictEqual(lines.length, 0,
      `savingsLedger() wrote to stdout/stderr: ${lines.join('')}`);
  });

  // ── state() — plain JSON contract (cubic-dev-ai P0 + P2) ─────────────────

  await run('state() returns a Promise', () => {
    const tmpDb = path.join(os.tmpdir(), `egc-test-state-${Date.now()}.db`);
    const result = state({ dbPath: tmpDb });
    assert.ok(result && typeof result.then === 'function',
      'state() must return a Promise');
    // Clean up: resolve it
    return result.catch(() => { /* ignore DB open failure, tested in later assertions */ }).finally(() => {
      try { fs.unlinkSync(tmpDb); } catch (_) { /* temp file may not exist: ignore */ }
    });
  });

  await run('state() result is plain JSON-serializable (not a live store)', async () => {
    const tmpDb = path.join(os.tmpdir(), `egc-test-state-${Date.now()}.db`);
    try {
      const result = await state({ dbPath: tmpDb });
      // Must NOT have live store methods
      assert.ok(!Object.hasOwn(result, 'close'),   'state() result must not have close()');
      assert.ok(!Object.hasOwn(result, 'flush'),   'state() result must not have flush()');
      assert.ok(!Object.hasOwn(result, '_database'),'state() result must not have _database');
      // Must be a plain JSON object
      const json = JSON.stringify(result);
      assert.deepStrictEqual(JSON.parse(json), result, 'state() result must survive JSON round-trip');
    } finally {
      try { fs.unlinkSync(tmpDb); } catch (_) { /* temp file may not exist: ignore */ }
    }
  });

  await run('state() result has expected numeric keys', async () => {
    const tmpDb = path.join(os.tmpdir(), `egc-test-state-${Date.now()}.db`);
    try {
      const result = await state({ dbPath: tmpDb });
      assert.ok(typeof result.decisions === 'number', 'state().decisions must be a number');
      assert.ok(typeof result.lessons   === 'number', 'state().lessons must be a number');
      assert.ok(typeof result.patterns  === 'number', 'state().patterns must be a number');
      assert.ok(typeof result.dbPath    === 'string', 'state().dbPath must be a string');
    } finally {
      try { fs.unlinkSync(tmpDb); } catch (_) { /* temp file may not exist: ignore */ }
    }
  });

  await run('state() does not write to console', async () => {
    const tmpDb = path.join(os.tmpdir(), `egc-test-state-${Date.now()}.db`);
    try {
      const lines = await captureConsole(() => state({ dbPath: tmpDb }));
      assert.strictEqual(lines.length, 0,
        `state() wrote to stdout/stderr: ${lines.join('')}`);
    } finally {
      try { fs.unlinkSync(tmpDb); } catch (_) { /* temp file may not exist: ignore */ }
    }
  });

  // ── install() — no-console contract (cubic-dev-ai P2) ────────────────────

  await run('install is exported as a function', () => {
    assert.strictEqual(typeof install, 'function');
  });

  // ── Deleted file guard ────────────────────────────────────────────────────

  await run('egc_dashboard_runtime.py has been deleted', () => {
    const deadFile = path.join(__dirname, '../../scripts/lib/egc_dashboard_runtime.py');
    assert.ok(!fs.existsSync(deadFile),
      'scripts/lib/egc_dashboard_runtime.py must be deleted');
  });

  // ── Print results ─────────────────────────────────────────────────────────

  console.log('\noperations registry\n');
  for (const r of results) {
    if (r.ok) {
      console.log(`  \u2713 ${r.name}`);
    } else {
      console.log(`  \u2717 ${r.name}`);
      console.log(`    ${r.message}`);
    }
  }
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
