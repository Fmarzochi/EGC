/**
 * Tests for mcp/servers/egc-memory/src/sync/private-path.ts, the server's
 * copy of the rule scripts/lib/team-config.js applies to ~/.egc/team.json:
 * the POSIX mode where modes exist, an icacls ACL for the user alone on
 * Windows. Runs against the built server, as the other server tests do, and
 * skips when the server is not built.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = path.join(__dirname, '../../mcp/servers/egc-memory/build/sync/private-path.js');
if (!fs.existsSync(MODULE_PATH)) {
  console.error(`[SKIP] Missing ${MODULE_PATH}. Build mcp/servers/egc-memory first.`);
  process.exit(0);
}

const { ACL_TIMEOUT_MS, makePrivate, privateAclCommands, windowsAccount } = require(MODULE_PATH);

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

console.log('\n=== Testing egc-memory sync/private-path ===\n');
const results = [
  test('the Windows account is DOMAIN\\user when the session names a domain, the user alone otherwise', () => {
    assert.strictEqual(windowsAccount({ USERNAME: 'ana', USERDOMAIN: 'CASA' }), 'CASA\\ana');
    assert.strictEqual(windowsAccount({ USERNAME: 'ana' }), 'ana');
  }),

  test('the icacls calls remove the inherited entries and grant the account alone; a directory, which may exist from before, has its list reset first', () => {
    assert.deepStrictEqual(
      privateAclCommands('C:\\Users\\ana\\.egc\\team.json', false, 'CASA\\ana'),
      [['icacls', ['C:\\Users\\ana\\.egc\\team.json', '/inheritance:r', '/grant:r', 'CASA\\ana:F']]]
    );
    assert.deepStrictEqual(
      privateAclCommands('C:\\Users\\ana\\.egc', true, 'ana'),
      [
        ['icacls', ['C:\\Users\\ana\\.egc', '/reset']],
        ['icacls', ['C:\\Users\\ana\\.egc', '/inheritance:r', '/grant:r', 'ana:(OI)(CI)F']],
      ]
    );
  }),

  test('on Windows makePrivate runs every icacls call with a timeout and the account of the environment, and reports a refusal or a missing icacls as false', () => {
    const calls = [];
    const run = (command, args, options) => { calls.push([command, args, options]); return { status: 0 }; };
    const env = { USERNAME: 'ana', USERDOMAIN: 'CASA' };
    assert.strictEqual(makePrivate('C:\\x\\team.json', 0o600, { platform: 'win32', run, env }), true);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].slice(0, 2), ['icacls', ['C:\\x\\team.json', '/inheritance:r', '/grant:r', 'CASA\\ana:F']]);
    assert.strictEqual(makePrivate('C:\\x', 0o700, { platform: 'win32', directory: true, run, env }), true);
    assert.strictEqual(calls.length, 3);
    assert.deepStrictEqual(calls[1].slice(0, 2), ['icacls', ['C:\\x', '/reset']]);
    assert.strictEqual(calls[2][1][3], 'CASA\\ana:(OI)(CI)F');
    assert.ok(calls.every(call => call[2].timeout === ACL_TIMEOUT_MS), 'the reset and the grants alike are bounded');
    let attempts = 0;
    assert.strictEqual(makePrivate('C:\\x', 0o700, { platform: 'win32', directory: true, env, run: () => ({ status: attempts++ === 0 ? 0 : 5 }) }), false, 'a grant refused after the reset');
    let resetCalls = 0;
    assert.strictEqual(makePrivate('C:\\x', 0o700, { platform: 'win32', directory: true, env, run: () => ({ status: ++resetCalls === 1 ? 5 : 0 }) }), false, 'a refused reset');
    assert.strictEqual(resetCalls, 1, 'a refused reset stops there');
    assert.strictEqual(makePrivate('C:\\x\\team.json', 0o600, { platform: 'win32', env, run: () => ({ status: 5 }) }), false, 'a refused grant');
    assert.strictEqual(makePrivate('C:\\x\\team.json', 0o600, { platform: 'win32', env, run: () => { throw new Error('no icacls'); } }), false, 'a missing icacls');
  }),

  test('elsewhere makePrivate applies the POSIX mode and answers false where it cannot', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-private-path-'));
    try {
      const file = path.join(home, 'secret');
      fs.writeFileSync(file, 'x');
      assert.strictEqual(makePrivate(file, 0o600, { platform: 'linux' }), true, 'chmod on a file that exists');
      if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      }
      assert.strictEqual(makePrivate(path.join(home, 'missing'), 0o600, { platform: 'linux' }), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }),
];

const failed = results.filter(result => !result).length;
console.log(`\nResults: Passed: ${results.length - failed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
