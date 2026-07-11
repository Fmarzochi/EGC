/**
 * Tests for normalizeLimit boundary inputs.
 * normalizeLimit throws on invalid values by design (contract pinned by
 * tests/lib/state-store.test.js) — callers rely on the throw to surface bad
 * MCP tool arguments instead of silently substituting a default.
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

test('normalizeLimit returns the fallback for undefined/null', () => {
  assert.strictEqual(normalizeLimit(undefined, 10), 10);
  assert.strictEqual(normalizeLimit(null, 10), 10);
});

test('normalizeLimit throws on zero, negative, non-finite, or non-numeric input', () => {
  assert.throws(() => normalizeLimit(0, 10), /Invalid limit: 0/);
  assert.throws(() => normalizeLimit(-1, 10), /Invalid limit: -1/);
  assert.throws(() => normalizeLimit(NaN, 10), /Invalid limit: NaN/);
  assert.throws(() => normalizeLimit(Infinity, 10), /Invalid limit: Infinity/);
  assert.throws(() => normalizeLimit('abc', 10), /Invalid limit: abc/);
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
