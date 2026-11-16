'use strict';
/**
 * The memory server's rate limiter (#2142): the per-tool, per-project bucket
 * the Guardian uses, with the settings both servers read from the environment.
 *
 * Run with: node tests/egc-memory-rate-limit.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const buildPath = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'rate-limit.js');
if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-memory first.');
  process.exit(0);
}
const { createRateLimiter, rateLimitSettings } = require(buildPath);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

console.log('\n=== egc-memory rate limiter ===\n');

test('a burst over the limit is refused and a steady rate under it is not', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, maxCalls: 5 });
  for (let i = 0; i < 5; i++) assert.strictEqual(limiter.check('get_state', '/p', 1000 + i), true, `call ${i + 1} of the burst`);
  assert.strictEqual(limiter.check('get_state', '/p', 1005), false, 'the sixth call inside the window is refused');
  const steady = createRateLimiter({ windowMs: 60_000, maxCalls: 5 });
  for (let i = 0; i < 20; i++) assert.strictEqual(steady.check('get_state', '/p', i * 15_000), true, `a call every 15 s stays under 5 a minute (call ${i + 1})`);
});

test('tools and projects are counted apart, so one looping tool does not starve the others', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, maxCalls: 2 });
  assert.strictEqual(limiter.check('session_events', '/a', 0), true);
  assert.strictEqual(limiter.check('session_events', '/a', 1), true);
  assert.strictEqual(limiter.check('session_events', '/a', 2), false);
  assert.strictEqual(limiter.check('session_wait', '/a', 3), true, 'another tool of the same project is not affected');
  assert.strictEqual(limiter.check('session_events', '/b', 4), true, 'the same tool for another project is not affected');
  assert.strictEqual(limiter.check('session_events', '/a', 60_001), true, 'the window passes and the tool is admitted again');
});

test('rateLimitSettings reads the two variables and keeps the defaults for anything that is not a whole positive number', () => {
  const defaults = { windowMs: 60_000, maxCalls: 120 };
  assert.deepStrictEqual(rateLimitSettings({}, defaults), defaults);
  assert.deepStrictEqual(rateLimitSettings({ EGC_MCP_RATE_MAX_CALLS: '300', EGC_MCP_RATE_WINDOW_MS: '10000' }, defaults), { windowMs: 10_000, maxCalls: 300 });
  for (const bad of ['0', '-5', '1.5', 'many', '', '  ']) {
    assert.deepStrictEqual(rateLimitSettings({ EGC_MCP_RATE_MAX_CALLS: bad, EGC_MCP_RATE_WINDOW_MS: bad }, defaults), defaults, `"${bad}" keeps the defaults`);
  }
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
