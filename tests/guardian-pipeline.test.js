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
const scannerPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'egc-volatile-scanner.js');
const routerPath  = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'egc-chunk-router.js');
const crusherPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'egc-array-crusher.js');

const { scanVolatile } = require(scannerPath);
const { classifyChunk } = require(routerPath);
const { reduceJsonArray } = require(crusherPath);

// Simulate the pipeline as implemented in index.ts
function runPipeline(chunks) {
  const bytesBefore = chunks.reduce((a, c) => a + Buffer.byteLength(c, 'utf8'), 0);
  let volatileFindings = 0;
  let chunksCrushed = 0;
  const seen = new Set();
  const result = [];

  for (const chunk of chunks) {
    const findings = scanVolatile(chunk);
    volatileFindings += findings.length;

    const contentType = classifyChunk(chunk);
    let processed = chunk;

    if (contentType === 'json_array') {
      const crushed = reduceJsonArray(chunk);
      if (crushed !== null) {
        processed = crushed.crushed;
        chunksCrushed++;
      }
    }

    const key = processed.trim();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(processed);
    }
  }

  const bytesAfter = result.reduce((a, c) => a + Buffer.byteLength(c, 'utf8'), 0);
  const savingsPct = bytesBefore === 0 ? 0 : Math.round((1 - bytesAfter / bytesBefore) * 100);
  return { chunks: result, bytes_before: bytesBefore, bytes_after: bytesAfter, savings_pct: savingsPct, volatile_findings: volatileFindings, chunks_crushed: chunksCrushed };
}

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
