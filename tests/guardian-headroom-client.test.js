/**
 * Tests for HeadroomClient (compressViaHeadroom).
 * Run with: node tests/guardian-headroom-client.test.js
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

async function testAsync(name, fn) {
  try {
    await fn();
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

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'headroom-client.js');

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}

const { compressViaHeadroom } = require(buildPath);

async function run() {
  // Headroom proxy almost certainly not running in CI — expect graceful null
  if (await testAsync('returns null when Headroom proxy is not reachable', async () => {
    const result = await compressViaHeadroom(['hello world'], 'http://localhost:19999');
    assert.strictEqual(result, null, 'should return null when proxy is down');
  })) passed++; else failed++;

  if (await testAsync('returns null for empty chunk list', async () => {
    const result = await compressViaHeadroom([], 'http://localhost:19999');
    assert.strictEqual(result, null, 'should return null for empty input');
  })) passed++; else failed++;

  if (test('module exports compressViaHeadroom as a function', () => {
    assert.strictEqual(typeof compressViaHeadroom, 'function', 'compressViaHeadroom should be a function');
  })) passed++; else failed++;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
