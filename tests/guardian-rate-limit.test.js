'use strict';

/**
 * Tests for mcp/servers/egc-guardian/src/rate-limit.ts (#1682): the per-tool,
 * per-project call counter admits maxCalls per window, keeps projects apart,
 * and forgets a key once its newest call has left the window, so the map
 * stays bounded by the keys active in the last window.
 *
 * Run with: node tests/guardian-rate-limit.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build', 'rate-limit.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { createRateLimiter } = require(buildPath);

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;
const tally = ok => { if (ok) passed++; else failed++; };

console.log('\n=== Testing the Guardian rate limiter ===\n');

tally(test('admits maxCalls per window per key and refuses the next call', () => {
  const limiter = createRateLimiter({ windowMs: 1000, maxCalls: 2 });
  assert.strictEqual(limiter.check('validate_command', '/p', 1000), true);
  assert.strictEqual(limiter.check('validate_command', '/p', 1001), true);
  assert.strictEqual(limiter.check('validate_command', '/p', 1002), false, 'the third call inside the window is refused');
  assert.strictEqual(limiter.check('validate_command', '/other', 1003), true, 'another project has its own key');
  assert.strictEqual(limiter.check('reduce_context', '/p', 1004), true, 'another tool has its own key');
  assert.strictEqual(limiter.check('validate_command', '  /p  ', 1005), false, 'the project path is trimmed into the same key');
  assert.strictEqual(limiter.size(), 3);
}));

tally(test('a key regains room once its old calls leave the window', () => {
  const limiter = createRateLimiter({ windowMs: 1000, maxCalls: 1 });
  assert.strictEqual(limiter.check('t', null, 5000), true);
  assert.strictEqual(limiter.check('t', null, 5500), false, 'a refused call still counts, as it always did');
  assert.strictEqual(limiter.check('t', null, 6000), false, 'the refused call of 5500 is still inside the window');
  assert.strictEqual(limiter.check('t', null, 7100), true, 'every recorded call aged out of the window');
}));

tally(test('a key whose newest call left the window is evicted on the next check of any key', () => {
  const limiter = createRateLimiter({ windowMs: 1000, maxCalls: 60 });
  for (let i = 0; i < 50; i++) limiter.check('validate_command', `/project-${i}`, 10_000 + i);
  assert.strictEqual(limiter.size(), 50, 'fifty projects, fifty keys');
  limiter.check('validate_command', '/project-0', 10_500);
  assert.strictEqual(limiter.size(), 50, 'inside the window nothing is evicted');
  limiter.check('validate_command', '/fresh', 11_600);
  assert.strictEqual(limiter.size(), 1, 'every idle key went; only the fresh one remains');
  assert.strictEqual(limiter.check('validate_command', '/project-0', 11_601), true, 'an evicted key starts again with a clean count');
}));

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
