/**
 * Tests for normalizeLimit boundary inputs
 */
const assert = require('node:assert');
const { normalizeLimit } = require('../../scripts/lib/state-store/queries.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.error(`    Error: ${err.message}`);
    failed++;
  }
}

test('normalizeLimit handles valid positive integers', () => {
  assert.strictEqual(normalizeLimit(5, 10), 5);
  assert.strictEqual(normalizeLimit(100, 10), 100);
});

test('normalizeLimit handles string representations of positive integers', () => {
  assert.strictEqual(normalizeLimit('15', 10), 15);
});

test('normalizeLimit handles boundary and invalid inputs', () => {
  assert.strictEqual(normalizeLimit(0, 10), 10, '0 should return fallback');
  assert.strictEqual(normalizeLimit(-1, 10), 10, '-1 should return fallback');
  assert.strictEqual(normalizeLimit(NaN, 10), 10, 'NaN should return fallback');
  assert.strictEqual(normalizeLimit(Infinity, 10), 10, 'Infinity should return fallback');
  assert.strictEqual(normalizeLimit(undefined, 10), 10, 'undefined should return fallback');
  assert.strictEqual(normalizeLimit(null, 10), 10, 'null should return fallback');
  assert.strictEqual(normalizeLimit('abc', 10), 10, '"abc" should return fallback');
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
