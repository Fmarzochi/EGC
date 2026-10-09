'use strict';
/**
 * scoreDocuments combines the registered per-file signals, then the
 * import-graph propagator, and returns documents best first with a per-signal
 * breakdown. Ties break on path.
 *
 * Run with: node tests/egc-guardian-filerank-score.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'file-ranker.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { scoreDocuments, tokenize, registeredSignals, Bm25Index } = require(buildPath);

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
const docOf = (p, summary = '') => ({
  path: p,
  fields: { path: tokenize(p), symbols: [], keywords: [], summary: tokenize(summary) }
});
const ctx = (query, edges = [], extras = {}) => ({ query, history: '', edges, extras });

run('registered weights match the issue: bm25 1.0, path_hit 1.5, import_graph 1.2', () => {
  const w = registeredSignals();
  assert.strictEqual(w.bm25, 1.0);
  assert.strictEqual(w.path_hit, 1.5);
  assert.strictEqual(w.import_graph, 1.2);
});

run('a file whose path segment matches the query ranks first, with a path_hit breakdown', () => {
  const docs = [docOf('src/misc.ts', 'payments'), docOf('billing/payments.ts', 'something else')];
  const ranked = scoreDocuments(docs, ctx('fix payments'));
  assert.strictEqual(ranked[0].doc.path, 'billing/payments.ts');
  const names = ranked[0].signals.map(s => s.name);
  assert.ok(names.includes('path_hit') && names.includes('bm25'));
});

run('path_hit counts a query term once for each path token and once more for the file stem', () => {
  // query tokens: payment, bill. path tokens: bill, payment. stem: payment.
  const ranked = scoreDocuments([docOf('billing/payments.ts')], ctx('payments billing'));
  const ph = ranked[0].signals.find(s => s.name === 'path_hit');
  assert.strictEqual(ph.raw, 3);
  assert.strictEqual(ph.weight, 1.5);
});

run('import_graph: the seed gets 0, a one-hop neighbour 1.0, a two-hop file 0.5 (undirected)', () => {
  const docs = [docOf('a.ts', 'billing'), docOf('b.ts'), docOf('c.ts'), docOf('d.ts')];
  const edges = [{ from: 'a.ts', to: 'b.ts', rel: 'imports' }, { from: 'c.ts', to: 'b.ts', rel: 'imports' }];
  const ranked = scoreDocuments(docs, ctx('billing', edges), { signals: ['bm25'] });
  const ig = p => ranked.find(r => r.doc.path === p).signals.find(s => s.name === 'import_graph');
  assert.strictEqual(ig('a.ts').raw, 0, 'seed is not boosted by its own walk');
  assert.strictEqual(ig('b.ts').raw, 1.0, 'one hop from the seed: 0.5^0');
  assert.strictEqual(ig('c.ts').raw, 0.5, 'two hops from the seed: 0.5^1');
  assert.strictEqual(ig('d.ts').raw, 0, 'unconnected');
});

run('import_graph: hops 0 disables the walk; no edges gives zero contributions', () => {
  const docs = [docOf('a.ts', 'billing'), docOf('b.ts')];
  const edges = [{ from: 'a.ts', to: 'b.ts', rel: 'imports' }];
  const off = scoreDocuments(docs, ctx('billing', edges, { graphHops: 0 }));
  assert.ok(off.every(r => r.signals.find(s => s.name === 'import_graph').raw === 0));
  const none = scoreDocuments(docs, ctx('billing', []));
  assert.ok(none.every(r => r.signals.find(s => s.name === 'import_graph').raw === 0));
});

run('import_graph seeds only the top 5 files: a sixth file is reached as a neighbour, not a seed', () => {
  // m0..m6 all match equally, so they rank by path: m0..m4 are the five seeds.
  const docs = Array.from({ length: 7 }, (_, i) => docOf(`m${i}.ts`, 'billing'));
  const edges = [
    { from: 'm4.ts', to: 'm5.ts', rel: 'imports' },
    { from: 'm6.ts', to: 'm5.ts', rel: 'imports' }
  ];
  const ranked = scoreDocuments(docs, ctx('billing', edges));
  const ig = p => ranked.find(r => r.doc.path === p).signals.find(s => s.name === 'import_graph').raw;
  assert.strictEqual(ig('m5.ts'), 1.0, 'm5 is one hop from seed m4, so it is not itself a seed');
  assert.strictEqual(ig('m6.ts'), 0.5, 'm6 is two hops from seed m4');
});

run('a query with no usable words scores every file zero and returns all of them in path order', () => {
  const docs = [docOf('b.ts'), docOf('a.ts')];
  const ranked = scoreDocuments(docs, ctx('the and'));
  assert.deepStrictEqual(ranked.map(r => r.doc.path), ['a.ts', 'b.ts']);
  assert.ok(ranked.every(r => r.total === 0));
});

run('weights override: weight 0 removes a signal from the breakdown', () => {
  const ranked = scoreDocuments([docOf('billing.ts')], ctx('billing'), { weights: { path_hit: 0 } });
  assert.ok(!ranked[0].signals.some(s => s.name === 'path_hit'));
});

run('the same input always gives the same order', () => {
  const docs = [docOf('x.ts', 'billing'), docOf('y.ts', 'billing'), docOf('z.ts', 'billing')];
  const a = scoreDocuments(docs, ctx('billing')).map(r => r.doc.path);
  const b = scoreDocuments(docs, ctx('billing')).map(r => r.doc.path);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a, ['x.ts', 'y.ts', 'z.ts']);
});

run('query terms are expanded against the vocabulary once per run, not once per document', () => {
  const docs = Array.from({ length: 200 }, (_, i) => docOf(`pkg/file${i}.ts`, `billing payment helper number${i}`));
  const original = Bm25Index.prototype.expand;
  let calls = 0;
  Bm25Index.prototype.expand = function (...args) {
    calls++;
    return original.apply(this, args);
  };
  try {
    scoreDocuments(docs, { query: 'billing payments', history: 'refund handling', edges: [], extras: {} });
  } finally {
    Bm25Index.prototype.expand = original;
  }
  assert.ok(calls <= 2, `expand ran ${calls} times for ${docs.length} documents`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
