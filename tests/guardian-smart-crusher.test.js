/**
 * Tests for SmartCrusher (crushJsonArray).
 * Run with: node tests/guardian-smart-crusher.test.js
 */

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

function test(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'smart-crusher.js');

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

const { crushJsonArray } = require(buildPath);

function makeRows(n, valueFn) {
  return JSON.stringify(Array.from({ length: n }, (_, i) => valueFn(i)));
}

if (test('returns null for non-JSON input', () => {
  assert.strictEqual(crushJsonArray('not json at all'), null);
})) passed++; else failed++;

if (test('returns null for JSON object (not array)', () => {
  assert.strictEqual(crushJsonArray('{"key":"value"}'), null);
})) passed++; else failed++;

if (test('returns null for array smaller than MIN_ROWS', () => {
  const small = JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.strictEqual(crushJsonArray(small), null);
})) passed++; else failed++;

if (test('deduplicates identical rows', () => {
  const rows = makeRows(10, () => ({ status: 'ok', code: 200 }));
  const result = crushJsonArray(rows);
  assert.ok(result !== null, 'should return a result');
  assert.strictEqual(result.rows_after, 1, 'all identical rows collapse to 1');
  assert.ok(result.savings_pct > 0, 'should have savings');
})) passed++; else failed++;

if (test('caps output at MAX_ROWS_AFTER_CRUSH', () => {
  const rows = makeRows(50, i => ({ id: i, name: `item-${i}`, value: Math.random() }));
  const result = crushJsonArray(rows);
  assert.ok(result !== null, 'should return result for 50 unique rows');
  assert.ok(result.rows_after <= 10, `rows_after ${result.rows_after} should be <= 10`);
})) passed++; else failed++;

if (test('preserves all rows when all are unique and under cap', () => {
  const rows = makeRows(7, i => ({ id: i, name: `unique-${i}` }));
  const result = crushJsonArray(rows);
  // 7 unique rows under cap of 10, no dups => null (no savings possible)
  assert.strictEqual(result, null, 'no savings if all unique and under cap');
})) passed++; else failed++;

if (test('returns valid JSON in crushed output', () => {
  const rows = makeRows(20, i => ({ id: i % 5, type: 'event', payload: `data-${i % 3}` }));
  const result = crushJsonArray(rows);
  assert.ok(result !== null, 'should crush repeated patterns');
  const reparsed = JSON.parse(result.crushed);
  assert.ok(Array.isArray(reparsed), 'crushed output must be valid JSON array');
})) passed++; else failed++;

if (test('savings_pct is between 0 and 100', () => {
  const rows = makeRows(20, i => ({ id: i % 5, label: 'same' }));
  const result = crushJsonArray(rows);
  assert.ok(result !== null, 'should have result');
  assert.ok(result.savings_pct >= 0 && result.savings_pct <= 100);
})) passed++; else failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
