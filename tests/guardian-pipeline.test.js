/**
 * Integration test for the reduce_context compression pipeline.
 * Exercises CacheAligner + ContentRouter + SmartCrusher wired together.
 * Run with: node tests/guardian-pipeline.test.js
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

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'index.js');

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

// Write a temp file and call reduce_context via the exported pipeline logic.
// We test the compressor modules directly since the MCP server requires stdio transport.
const routerPath  = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'egc-chunk-router.js');

const { classifyChunk } = require(routerPath);

const pipelinePath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'compression-pipeline.js');
const { CRUSH_MARKER, runCompressionPipeline: runPipeline, splitAlreadyCrushed } = require(pipelinePath);

if (test('a chunk the Token Crusher already compressed comes back untouched, uncounted and unscanned (#1682)', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: i % 5, type: 'event', msg: 'same' }));
  const crushed = `${CRUSH_MARKER} 20 rows, 5 ids\n${JSON.stringify(rows)}`;
  const r = runPipeline([crushed, 'session: 550e8400-e29b-41d4-a716-446655440000']);
  assert.strictEqual(r.chunks[0], crushed, 'the marked chunk is returned byte for byte');
  assert.strictEqual(r.chunks_crushed, 0, 'and is not crushed again');
  assert.strictEqual(r.volatile_findings, 1, 'only the unmarked chunk is scanned');
  const plain = runPipeline([JSON.stringify(rows)]);
  assert.strictEqual(plain.chunks_crushed, 1, 'the same text without the marker is crushed');
})) passed++; else failed++;

if (test('a chunk that only quotes the marker mid-line is scanned and crushed like any other', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: i % 5, note: `mentions ${CRUSH_MARKER} once` }));
  const r = runPipeline([JSON.stringify(rows), `session 550e8400-e29b-41d4-a716-446655440000 per the ${CRUSH_MARKER} docs`]);
  assert.strictEqual(r.chunks_crushed, 1, 'the JSON array is crushed');
  assert.strictEqual(r.volatile_findings, 1, 'the text chunk is scanned');
})) passed++; else failed++;

if (test('the chunks the Crusher already compressed are kept apart from the ones Headroom may still compress, in order', () => {
  const a = 'first fresh';
  const b = `rows\n${CRUSH_MARKER} saved ~12 tokens`;
  const c = 'second fresh';
  const d = `${CRUSH_MARKER} trailer first`;
  assert.deepStrictEqual(splitAlreadyCrushed([a, b, c, d]), { fresh: [a, c], crushed: [b, d] });
  assert.deepStrictEqual(splitAlreadyCrushed([]), { fresh: [], crushed: [] });
})) passed++; else failed++;

if (test('the marker is the one scripts/lib/crusher/engine.js writes', () => {
  const engine = require(path.join(__dirname, '..', 'scripts', 'lib', 'crusher', 'engine.js'));
  const written = typeof engine.CRUSH_MARKER === 'string' ? engine.CRUSH_MARKER : fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'crusher', 'engine.js'), 'utf8').match(/const CRUSH_MARKER = '([^']+)'/)[1];
  assert.strictEqual(CRUSH_MARKER, written);
})) passed++; else failed++;

if (test('pipeline deduplicates identical text chunks', () => {
  const chunks = ['hello world', 'hello world', 'hello world'];
  const r = runPipeline(chunks);
  assert.strictEqual(r.chunks.length, 1);
  assert.ok(r.savings_pct > 0);
})) passed++; else failed++;

if (test('pipeline crushes large JSON array chunk', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: i % 5, type: 'event', msg: 'same' }));
  const chunks = [JSON.stringify(rows)];
  const r = runPipeline(chunks);
  assert.strictEqual(r.chunks_crushed, 1, 'should crush one JSON chunk');
  assert.ok(r.savings_pct > 0, 'should save bytes');
})) passed++; else failed++;

if (test('pipeline detects volatile content and counts findings', () => {
  const chunks = [
    'session: 550e8400-e29b-41d4-a716-446655440000',
    'updated at 2026-06-19T21:00:00Z',
  ];
  const r = runPipeline(chunks);
  assert.ok(r.volatile_findings >= 2, 'should detect uuid + iso8601');
})) passed++; else failed++;

if (test('pipeline does not inflate output (safety net)', () => {
  const chunks = Array.from({ length: 5 }, (_, i) => `unique content block ${i} with distinct text`);
  const r = runPipeline(chunks);
  assert.ok(r.bytes_after <= r.bytes_before, 'bytes_after must never exceed bytes_before');
})) passed++; else failed++;

if (test('pipeline handles empty chunk list', () => {
  const r = runPipeline([]);
  assert.strictEqual(r.chunks.length, 0);
  assert.strictEqual(r.savings_pct, 0);
})) passed++; else failed++;

if (test('pipeline handles mixed chunk types', () => {
  const jsonChunk = JSON.stringify(Array.from({ length: 15 }, (_, i) => ({ id: i % 3, label: 'x' })));
  const codeChunk = 'import { foo } from "bar";\nconst x = 1;';
  const textChunk = 'This is a plain text description.';
  const r = runPipeline([jsonChunk, codeChunk, textChunk]);
  assert.ok(r.chunks.length <= 3, 'no chunk should be duplicated');
  assert.ok(r.bytes_after <= r.bytes_before);
})) passed++; else failed++;

if (test('routes an object wrapping a list to the JSON crusher, not to text', () => {
  // The crusher can reduce a list nested one key down, but the pipeline only
  // hands it chunks classified as json_array. Requiring a leading '[' meant
  // the common {"items": [...], "totalCount": N} shape never reached it.
  const items = Array.from({ length: 12 }, (_, i) => ({ id: i % 3, state: 'open' }));
  assert.strictEqual(classifyChunk(JSON.stringify({ items, totalCount: 12 })), 'json_array');
  assert.strictEqual(classifyChunk(JSON.stringify(items)), 'json_array', 'top-level lists keep working');
  assert.notStrictEqual(
    classifyChunk(JSON.stringify({ status: 'ok', count: 2 })),
    'json_array',
    'an object with no list must not be routed to the list crusher'
  );
})) passed++; else failed++;

if (test('crushes an object-wrapped list end to end and keeps its surrounding fields', () => {
  // Routing alone proves nothing: this runs the whole pipeline and checks
  // the payload that comes out the other side.
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i % 4, state: 'open', title: `t-${i % 3}` }));
  const payload = JSON.stringify({ items, totalCount: 30, pageInfo: { hasNextPage: false } });

  const r = runPipeline([payload]);
  assert.strictEqual(r.chunks_crushed, 1, 'the object-wrapped list must actually be crushed');
  assert.ok(r.bytes_after < r.bytes_before, 'the crushed payload must be smaller');

  const out = JSON.parse(r.chunks[0]);
  assert.strictEqual(out.totalCount, 30, 'totalCount must survive the pipeline');
  assert.deepStrictEqual(out.pageInfo, { hasNextPage: false }, 'pagination must survive the pipeline');
  assert.ok(out.items.length < items.length, 'the list itself must be reduced');
})) passed++; else failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
