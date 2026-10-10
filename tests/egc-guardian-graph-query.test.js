'use strict';
/**
 * The graph query turns a task prompt into a short, ranked, budgeted list of
 * code snippets, with the reason each one is there.
 *
 * Run with: node tests/egc-guardian-graph-query.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'graph-query.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { queryGraph, splitWords } = require(buildPath);

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.stack || err.message}`);
    failed++;
  }
}

const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
const SOURCES = {
  'validator.js': ['export function validateCommand(cmd) {', '  return cmd;', '}', '', 'export function isProtectedPath(p) {', '  return p;', '}'].join('\n'),
  'index.js': ['function handleTask(x) {', '  return validateCommand(x);', '}'].join('\n'),
  'util.js': ['export function formatDate(d) {', '  return d;', '}'].join('\n')
};
const readFile = async rel => SOURCES[rel] ?? null;
const sym = (id, file, name, startLine, endLine, extra = {}) => ({ id, file, name, kind: 'function', exported: true, startLine, endLine, refs: [], ...extra });
const GRAPH = {
  files: Object.keys(SOURCES).map(p => ({ path: p, mtimeMs: 1, size: 1, hash: 'h' })),
  symbols: [
    sym(1, 'validator.js', 'validateCommand', 1, 3),
    sym(2, 'validator.js', 'isProtectedPath', 5, 7),
    sym(3, 'index.js', 'handleTask', 1, 3, { exported: false }),
    sym(4, 'util.js', 'formatDate', 1, 3)
  ],
  imports: [],
  edges: [{ src: 's:3', dst: 's:1', kind: 'ref' }]
};

(async () => {
  await run('splitWords splits camelCase and snake_case and drops stopwords and short words', () => {
    assert.deepStrictEqual(splitWords('Fix the validateCommand bug in my_helper_fn'), ['fix', 'validate', 'command', 'bug', 'helper']);
  });

  await run('splitWords keeps its acronym boundaries and is linear on a long run of capitals', () => {
    assert.deepStrictEqual(splitWords('parseHTTPServer ABCDef XMLHttpRequest'), ['parse', 'http', 'server', 'abc', 'def', 'xml', 'http', 'request']);
    // The repository controls the identifier: a quadratic split here blocks the whole server.
    // 100,000 capitals took about eleven seconds with the backtracking form; a linear one takes milliseconds.
    const run = 'A'.repeat(100000);
    const started = Date.now();
    assert.deepStrictEqual(splitWords(run), [run.toLowerCase()]);
    // The last capital before a lowercase letter starts the next word: AAA...A + Ax, and Ax is under three letters.
    assert.deepStrictEqual(splitWords(`${run}x`), ['a'.repeat(99999)]);
    const ms = Date.now() - started;
    assert.ok(ms < 2000, `splitWords took ${ms} ms on a long run of capitals`);
  });

  await run('a named symbol ranks first and explains itself', async () => {
    const r = await queryGraph('fix validateCommand to reject empty input', GRAPH, { readFile });
    assert.strictEqual(r.files[0].path, 'validator.js');
    assert.strictEqual(r.files[0].snippets[0].symbol, 'validateCommand');
    assert.ok(r.files[0].snippets[0].text.includes('export function validateCommand'));
    assert.ok(r.files[0].why[0].startsWith('matched "'), r.files[0].why[0]);
  });

  await run('related code is pulled in by edges, with the direction in the reason; unrelated code is not', async () => {
    const r = await queryGraph('fix validateCommand', GRAPH, { readFile });
    const index = r.files.find(f => f.path === 'index.js');
    assert.ok(index, 'the caller is included');
    assert.deepStrictEqual(index.why, ['calls validateCommand']);
    assert.ok(!r.files.some(f => f.path === 'util.js'));
  });

  await run('the score depends on how rare the matched word is, not only on how many words match', async () => {
    // One match each. "zebra" appears in one symbol; "item" in many, so a hit on zebra must outrank a hit on item.
    const fillers = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((suffix, i) => sym(10 + i, 'filler.js', `item${suffix}`, 1, 3));
    const g = {
      files: [],
      symbols: [sym(1, 'a-common.js', 'itemThing', 1, 3), sym(2, 'z-rare.js', 'zebraThing', 1, 3), ...fillers],
      imports: [],
      edges: []
    };
    const r = await queryGraph('zebra item', g, { readFile: async () => 'line 1\nline 2\nline 3' });
    assert.strictEqual(r.files[0].snippets[0].symbol, 'zebraThing');
    const rare = r.files.find(f => f.path === 'z-rare.js');
    const common = r.files.find(f => f.path === 'a-common.js');
    assert.ok(rare.score > common.score, `rare ${rare.score} should beat common ${common.score}`);
    // With the file names ordered the other way the tie-break alone would pick the common word first.
    assert.ok('a-common.js' < 'z-rare.js');
  });

  await run('a symbol in the part of a trimmed snippet that was cut away is still shown', async () => {
    const sixty = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
    const g = {
      files: [],
      symbols: [sym(1, 'a.js', 'outerWidget', 1, 60), sym(2, 'a.js', 'innerWidget', 55, 58)],
      imports: [],
      edges: []
    };
    // A small budget, so the long outer symbol is cut well short of line 55.
    const r = await queryGraph('outerWidget innerWidget', g, { readFile: async () => sixty, budgetTokens: 200 });
    const shown = r.files.flatMap(f => f.snippets);
    const outer = shown.find(s => s.symbol === 'outerWidget');
    assert.ok(outer && outer.truncated && outer.endLine < 55, `the outer snippet was not cut short of line 55: ${JSON.stringify(outer)}`);
    assert.ok(shown.some(s => s.symbol === 'innerWidget'), 'the symbol in the cut-away part was dropped as if it had been shown');
  });

  await run('hops bound the expansion and each hop decays the score', async () => {
    const chain = {
      files: [{ path: 'c.js', mtimeMs: 1, size: 1, hash: 'h' }],
      symbols: ['alphaStep', 'betaNode', 'gammaLeaf'].map((n, i) => sym(i + 1, 'c.js', n, i * 2 + 1, i * 2 + 2)),
      imports: [],
      edges: [{ src: 's:1', dst: 's:2', kind: 'ref' }, { src: 's:2', dst: 's:3', kind: 'ref' }]
    };
    const src = { 'c.js': 'a1\na2\nb1\nb2\ng1\ng2' };
    const rf = async rel => src[rel] ?? null;
    const two = await queryGraph('alphaStep', chain, { readFile: rf, hops: 2 });
    const order = two.files[0].snippets.map(s => s.symbol);
    assert.deepStrictEqual(order, ['alphaStep', 'betaNode', 'gammaLeaf'], 'snippets of one file are in line order');
    const one = await queryGraph('alphaStep', chain, { readFile: rf, hops: 1 });
    assert.deepStrictEqual(one.files[0].snippets.map(s => s.symbol), ['alphaStep', 'betaNode']);
  });

  await run('rare words outweigh common ones (idf)', async () => {
    const syms = [sym(1, 'a.js', 'parseIndex', 1, 1), sym(2, 'a.js', 'validateCommand', 2, 2)];
    for (let i = 0; i < 6; i++) syms.push(sym(10 + i, 'a.js', `index${'ABCDEF'[i]}`, 3 + i, 3 + i));
    const g = { files: [{ path: 'a.js', mtimeMs: 1, size: 1, hash: 'h' }], symbols: syms, imports: [], edges: [] };
    const rf = async () => Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n');
    const r = await queryGraph('index validate command', g, { readFile: rf, seeds: 1, hops: 0 });
    assert.strictEqual(r.files[0].snippets[0].symbol, 'validateCommand');
  });

  await run('the token budget is a hard cap and reports truncation', async () => {
    const r = await queryGraph('validateCommand isProtectedPath handleTask', GRAPH, { readFile, budgetTokens: 25 });
    assert.ok(r.tokensEstimated <= 25, String(r.tokensEstimated));
    assert.strictEqual(r.truncated, true);
  });

  await run('a symbol bigger than 40% of the budget is cut and marked', async () => {
    const big = { files: [{ path: 'big.js', mtimeMs: 1, size: 1, hash: 'h' }], symbols: [sym(1, 'big.js', 'hugeFunction', 1, 200)], imports: [], edges: [] };
    const rf = async () => lines(200);
    const r = await queryGraph('hugeFunction', big, { readFile: rf, budgetTokens: 400 });
    const s = r.files[0].snippets[0];
    assert.strictEqual(s.truncated, true);
    assert.ok(s.text.length <= 400 * 4 * 0.4 + 20, String(s.text.length));
  });

  await run('transformSnippet can redact or drop a snippet', async () => {
    const r = await queryGraph('validateCommand', GRAPH, {
      readFile,
      transformSnippet: t => (t.includes('handleTask') ? null : t.replace('return cmd;', 'return [redacted];'))
    });
    assert.ok(r.files[0].snippets[0].text.includes('[redacted]'));
    assert.ok(!r.files.some(f => f.path === 'index.js'));
    assert.strictEqual(r.dropped, 1);
  });

  await run('no usable words or no match gives an empty result, never an error', async () => {
    for (const p of ['', '   ', 'the and for', '!!! ???', 'zzzqqq']) {
      const r = await queryGraph(p, GRAPH, { readFile });
      assert.deepStrictEqual(r.files, []);
      assert.strictEqual(r.tokensEstimated, 0);
    }
  });

  await run('ties are broken by path then line, so output is stable', async () => {
    const g = {
      files: [{ path: 'b.js', mtimeMs: 1, size: 1, hash: 'h' }, { path: 'a.js', mtimeMs: 1, size: 1, hash: 'h' }],
      symbols: [sym(1, 'b.js', 'sameName', 1, 1), sym(2, 'a.js', 'sameName', 1, 1)],
      imports: [],
      edges: []
    };
    const rf = async () => 'x';
    const r = await queryGraph('sameName', g, { readFile: rf });
    assert.deepStrictEqual(r.files.map(f => f.path), ['a.js', 'b.js']);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
