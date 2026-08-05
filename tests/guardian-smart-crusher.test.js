/**
 * Tests for SmartCrusher (reduceJsonArray).
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

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'egc-array-crusher.js');

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

const { reduceJsonArray } = require(buildPath);

function makeRows(n, valueFn) {
  return JSON.stringify(Array.from({ length: n }, (_, i) => valueFn(i)));
}

if (test('returns null for non-JSON input', () => {
  assert.strictEqual(reduceJsonArray('not json at all'), null);
})) passed++; else failed++;

if (test('returns null for JSON object (not array)', () => {
  assert.strictEqual(reduceJsonArray('{"key":"value"}'), null);
})) passed++; else failed++;

if (test('returns null for array smaller than MIN_ROWS', () => {
  const small = JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.strictEqual(reduceJsonArray(small), null);
})) passed++; else failed++;

if (test('deduplicates identical rows', () => {
  const rows = makeRows(10, () => ({ status: 'ok', code: 200 }));
  const result = reduceJsonArray(rows);
  assert.ok(result !== null, 'should return a result');
  assert.strictEqual(result.rows_after, 1, 'all identical rows collapse to 1');
  assert.ok(result.savings_pct > 0, 'should have savings');
})) passed++; else failed++;

if (test('caps output at MAX_ROWS_AFTER_CRUSH', () => {
  const rows = makeRows(50, i => ({ id: i, name: `item-${i}`, value: Math.random() }));
  const result = reduceJsonArray(rows);
  assert.ok(result !== null, 'should return result for 50 unique rows');
  assert.ok(result.rows_after <= 10, `rows_after ${result.rows_after} should be <= 10`);
})) passed++; else failed++;

if (test('preserves all rows when all are unique and under cap', () => {
  const rows = makeRows(7, i => ({ id: i, name: `unique-${i}` }));
  const result = reduceJsonArray(rows);
  // 7 unique rows under cap of 10, no dups => null (no savings possible)
  assert.strictEqual(result, null, 'no savings if all unique and under cap');
})) passed++; else failed++;

if (test('returns valid JSON in crushed output', () => {
  const rows = makeRows(20, i => ({ id: i % 5, type: 'event', payload: `data-${i % 3}` }));
  const result = reduceJsonArray(rows);
  assert.ok(result !== null, 'should crush repeated patterns');
  const reparsed = JSON.parse(result.crushed);
  assert.ok(Array.isArray(reparsed), 'crushed output must be valid JSON array');
})) passed++; else failed++;

if (test('savings_pct is between 0 and 100', () => {
  const rows = makeRows(20, i => ({ id: i % 5, label: 'same' }));
  const result = reduceJsonArray(rows);
  assert.ok(result !== null, 'should have result');
  assert.ok(result.savings_pct >= 0 && result.savings_pct <= 100);
})) passed++; else failed++;

if (test('crushes a list nested inside an object and keeps the surrounding fields', () => {
  // The shape of nearly every REST and CLI payload: the volume is one key
  // down, next to small scalars. Requiring an array at the top level let all
  // of those through at full size (a single `gh project item-list --format
  // json` read 637 KB before this).
  const items = JSON.parse(makeRows(40, i => ({ id: i % 4, status: 'open', label: `item-${i % 3}` })));
  const payload = JSON.stringify({ items, totalCount: 812, pageInfo: { hasNextPage: true } });

  const result = reduceJsonArray(payload);
  assert.ok(result !== null, 'a nested list must be crushed, not passed through');
  assert.strictEqual(result.rows_before, 40);
  assert.ok(result.rows_after < 40, 'rows must actually be reduced');

  const reparsed = JSON.parse(result.crushed);
  assert.strictEqual(reparsed.totalCount, 812, 'counts around the list must survive verbatim');
  assert.deepStrictEqual(reparsed.pageInfo, { hasNextPage: true }, 'pagination must survive verbatim');
  assert.strictEqual(reparsed.items.length, result.rows_after);
  assert.ok(result.crushed.length < payload.length, 'the crushed payload must be smaller');
})) passed++; else failed++;

if (test('picks the largest list when an object holds several', () => {
  const few = JSON.parse(makeRows(6, i => ({ id: i, kind: 'small' })));
  const many = JSON.parse(makeRows(30, i => ({ id: i % 3, kind: 'big' })));
  const result = reduceJsonArray(JSON.stringify({ few, many }));

  assert.ok(result !== null, 'should crush');
  assert.strictEqual(result.rows_before, 30, 'the largest list is the one worth reducing');
  const reparsed = JSON.parse(result.crushed);
  assert.strictEqual(reparsed.few.length, 6, 'the smaller list must be left alone');
})) passed++; else failed++;

if (test('leaves an object with no list of its own alone', () => {
  const result = reduceJsonArray(JSON.stringify({ status: 'ok', count: 3, nested: { a: 1 } }));
  assert.strictEqual(result, null, 'nothing to reduce means no rewrite');
})) passed++; else failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
