'use strict';
/**
 * The dashboard launcher opens one browser tab per launch (#2140): the script
 * it starts is told --no-browser and the opener here runs once, whether the
 * server was already up or had to be started. The opener, the spawner and
 * the ping are handed in, so no server and no browser are involved.
 *
 * Run with: node tests/lib/dashboard-launch.test.js
 */
const assert = require('node:assert');
const path = require('node:path');

const { launchDashboard } = require('../../scripts/lib/dashboard-launch');
const { wantsBrowser } = require('../../scripts/dashboard');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function recorder() {
  const calls = [];
  const spawner = (...args) => { calls.push(args); return { unref() {} }; };
  return { calls, spawner };
}

(async () => {
  console.log('\n=== Dashboard launcher: one tab per launch ===\n');

  await test('a server already answering opens the browser once and starts nothing', async () => {
    let opened = 0;
    const { calls, spawner } = recorder();
    const result = await launchDashboard({ browserOpener: () => { opened++; return true; }, spawner, ping: async () => true });
    assert.deepStrictEqual(result, { ready: true, browserOpened: true });
    assert.strictEqual(opened, 1);
    assert.deepStrictEqual(calls, []);
  });

  await test('a cold start runs the dashboard script with --no-browser and opens the browser once when it answers', async () => {
    let opened = 0;
    let pings = 0;
    const { calls, spawner } = recorder();
    const result = await launchDashboard({
      browserOpener: () => { opened++; return true; },
      spawner,
      ping: async () => { pings++; return pings >= 3; },
    });
    assert.deepStrictEqual(result, { ready: true, browserOpened: true });
    assert.strictEqual(opened, 1, 'the launcher is the only opener');
    assert.strictEqual(calls.length, 1, 'the script starts once');
    const [executable, scriptArgs] = calls[0];
    assert.strictEqual(executable, process.execPath);
    assert.strictEqual(path.basename(scriptArgs[0]), 'dashboard.js');
    assert.deepStrictEqual(scriptArgs.slice(1), ['start', '--no-browser']);
  });

  await test('the dashboard script reads --no-browser and opens the tab by default', () => {
    assert.strictEqual(wantsBrowser(['start', '--no-browser']), false);
    assert.strictEqual(wantsBrowser(['--no-browser']), false);
    assert.strictEqual(wantsBrowser(['start']), true);
    assert.strictEqual(wantsBrowser([]), true);
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
