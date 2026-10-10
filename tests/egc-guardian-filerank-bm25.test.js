'use strict';
/**
 * The BM25 index scores files by weighted term frequency, with field weights
 * (path over symbols over keywords over summary), inverse document frequency,
 * and query-term expansion to longer or stem-related vocabulary.
 *
 * Run with: node tests/egc-guardian-filerank-bm25.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'file-ranker.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { Bm25Index, FIELD_WEIGHTS, BM25_K1, BM25_B, HISTORY_TERM_WEIGHT } = require(buildPath);

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}
const doc = (p, fields = {}) => ({ path: p, fields: { path: [], symbols: [], keywords: [], summary: [], ...fields } });

run('constants match The Link', () => {
  assert.deepStrictEqual(FIELD_WEIGHTS, { path: 3.0, symbols: 2.5, keywords: 1.5, summary: 1.0 });
  assert.strictEqual(BM25_K1, 1.5);
  assert.strictEqual(BM25_B, 0.75);
  assert.strictEqual(HISTORY_TERM_WEIGHT, 0.4);
});

run('a hit in the path field outranks the same hit in the summary', () => {
  const docs = [doc('a.ts', { path: ['billing'] }), doc('b.ts', { summary: ['billing'] })];
  const idx = Bm25Index.build(docs);
  const q = idx.expand(['billing']);
  assert.ok(idx.score(0, q) > idx.score(1, q));
});

run('a term in every document carries no weight (idf is low)', () => {
  const docs = [doc('a.ts', { summary: ['common'] }), doc('b.ts', { summary: ['common'] }), doc('c.ts', { summary: ['common', 'rare'] })];
  const idx = Bm25Index.build(docs);
  assert.ok(idx.score(2, idx.expand(['rare'])) > idx.score(2, idx.expand(['common'])));
});

run('expand: exact hit weight 1.0; prefix and stem-family hits 0.5; unknown dropped', () => {
  const idx = Bm25Index.build([doc('a.ts', { summary: ['authentication'] })]);
  assert.deepStrictEqual(idx.expand(['authentication']), [['authentication', 1.0]]);
  assert.deepStrictEqual(idx.expand(['auth']), [['authentication', 0.5]]);
  assert.deepStrictEqual(idx.expand(['zzzz']), []);
});

run('a document with no matching terms scores zero; an empty corpus does not throw', () => {
  const idx = Bm25Index.build([doc('a.ts', { summary: ['alpha'] })]);
  assert.strictEqual(idx.score(0, idx.expand(['beta'])), 0);
  assert.strictEqual(Bm25Index.build([]).expand(['x']).length, 0);
});

run('the weighting is deterministic: same input, same scores', () => {
  const docs = [doc('a.ts', { path: ['billing'], summary: ['pay'] }), doc('b.ts', { summary: ['billing', 'pay'] })];
  const a = Bm25Index.build(docs);
  const b = Bm25Index.build(docs);
  assert.strictEqual(a.score(0, a.expand(['billing'])), b.score(0, b.expand(['billing'])));
});

run('the vocabulary is ordered by code unit, so the host locale cannot reorder the expansion of a query term', () => {
  const docs = [doc('a.ts', { summary: ['aaaaaa'] }), doc('b.ts', { summary: ['aaaaab'] }), doc('c.ts', { summary: ['aaaaaba'] })];
  const expected = Bm25Index.build(docs).expand(['aaaaa']).map(([t]) => t);
  assert.deepStrictEqual(expected, ['aaaaaa', 'aaaaab', 'aaaaaba']);
  if (Intl.Collator.supportedLocalesOf(['da']).length === 0) {
    console.log('    - no Danish collation data here; the order was checked in the default locale only');
    return;
  }
  // localeCompare reads the host's default locale, which a test cannot change, so the
  // same sort is run under a Danish collation, where "aa" sorts as one letter after z.
  const danish = new Intl.Collator('da');
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = function (other) {
    return danish.compare(String(this), other);
  };
  try {
    const under = Bm25Index.build(docs).expand(['aaaaa']).map(([t]) => t);
    assert.deepStrictEqual(under, expected, 'the expansion order followed the locale');
  } finally {
    String.prototype.localeCompare = original;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
