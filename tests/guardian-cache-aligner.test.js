/**
 * Tests for CacheAligner (scanVolatile) and ContentRouter (classifyChunk).
 * Run with: node tests/guardian-cache-aligner.test.js
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

const scannerPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'egc-volatile-scanner.js');
const routerPath  = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'egc-chunk-router.js');

if (!fs.existsSync(scannerPath) || !fs.existsSync(routerPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

const { scanVolatile } = require(scannerPath);
const { classifyChunk } = require(routerPath);

// CacheAligner tests

if (test('detects canonical UUID', () => {
  const r = scanVolatile('session id: 550e8400-e29b-41d4-a716-446655440000');
  assert.ok(r.some(f => f.label === 'uuid'), 'should find uuid');
})) passed++; else failed++;

if (test('detects ISO 8601 timestamp', () => {
  const r = scanVolatile('updated at 2026-06-19T21:32:00Z');
  assert.ok(r.some(f => f.label === 'iso8601'), 'should find iso8601');
})) passed++; else failed++;

if (test('detects JWT shape', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const r = scanVolatile(jwt);
  assert.ok(r.some(f => f.label === 'jwt'), 'should find jwt');
})) passed++; else failed++;

if (test('detects SHA256 hex hash', () => {
  const sha256 = 'a'.repeat(64);
  const r = scanVolatile(`hash: ${sha256}`);
  assert.ok(r.some(f => f.label === 'hex_hash'), 'should find hex_hash');
})) passed++; else failed++;

if (test('returns empty findings for plain text', () => {
  const r = scanVolatile('the quick brown fox jumps over the lazy dog');
  assert.strictEqual(r.length, 0, 'should have no findings');
})) passed++; else failed++;

if (test('deduplicates repeated UUIDs', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const r = scanVolatile(`${uuid} and again ${uuid}`);
  const uuidFindings = r.filter(f => f.label === 'uuid');
  assert.strictEqual(uuidFindings.length, 1, 'should deduplicate');
})) passed++; else failed++;

// ContentRouter tests

if (test('classifies JSON array', () => {
  const chunk = JSON.stringify([{ id: 1, name: 'foo' }, { id: 2, name: 'bar' }]);
  assert.strictEqual(classifyChunk(chunk), 'json_array');
})) passed++; else failed++;

if (test('classifies TypeScript code', () => {
  const chunk = 'import { foo } from "bar";\nconst x = async () => {};';
  assert.strictEqual(classifyChunk(chunk), 'code');
})) passed++; else failed++;

if (test('classifies log output', () => {
  const chunk = '[2026-06-19T21:00:00Z] ERROR something went wrong\nTraceback (most recent call last)';
  assert.strictEqual(classifyChunk(chunk), 'log');
})) passed++; else failed++;

if (test('classifies unified diff', () => {
  const chunk = '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,4 @@\n+import foo';
  assert.strictEqual(classifyChunk(chunk), 'diff');
})) passed++; else failed++;

if (test('classifies plain text as text', () => {
  const chunk = 'This is a summary of the project decisions made this week.';
  assert.strictEqual(classifyChunk(chunk), 'text');
})) passed++; else failed++;

if (test('JSON object (not array) is not classified as json_array', () => {
  const chunk = JSON.stringify({ key: 'value' });
  assert.notStrictEqual(classifyChunk(chunk), 'json_array');
})) passed++; else failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
