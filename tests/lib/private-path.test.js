/**
 * Tests for mcp/servers/egc-memory/src/sync/private-path.ts, the server's
 * copy of the rule scripts/lib/team-config.js applies to ~/.egc/team.json:
 * the POSIX mode where modes exist, an icacls ACL for the user alone on
 * Windows. Runs against the built server, as the other server tests do.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makePrivate, privateAclArguments, windowsAccount } = require('../../mcp/servers/egc-memory/build/sync/private-path.js');

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

  test('the icacls call removes the inherited entries and grants the account alone, inherited on a directory', () => {
    assert.deepStrictEqual(
      privateAclArguments('C:\\Users\\ana\\.egc\\team.json', false, 'CASA\\ana'),
      ['icacls', ['C:\\Users\\ana\\.egc\\team.json', '/inheritance:r', '/grant:r', 'CASA\\ana:F']]
    );
    assert.strictEqual(privateAclArguments('C:\\Users\\ana\\.egc', true, 'ana')[1][3], 'ana:(OI)(CI)F');
  }),

  test('on Windows makePrivate runs icacls with the account of the environment and reports a refusal or a missing icacls as false', () => {
    const calls = [];
    const run = (command, args) => { calls.push([command, args]); return { status: 0 }; };
    const env = { USERNAME: 'ana', USERDOMAIN: 'CASA' };
    assert.strictEqual(makePrivate('C:\\x\\team.json', 0o600, { platform: 'win32', run, env }), true);
    assert.deepStrictEqual(calls[0], ['icacls', ['C:\\x\\team.json', '/inheritance:r', '/grant:r', 'CASA\\ana:F']]);
    assert.strictEqual(makePrivate('C:\\x', 0o700, { platform: 'win32', directory: true, run, env }), true);
    assert.strictEqual(calls[1][1][3], 'CASA\\ana:(OI)(CI)F');
    assert.strictEqual(makePrivate('C:\\x\\team.json', 0o600, { platform: 'win32', env, run: () => ({ status: 5 }) }), false);
    assert.strictEqual(makePrivate('C:\\x\\team.json', 0o600, { platform: 'win32', env, run: () => { throw new Error('no icacls'); } }), false);
  }),

  test('elsewhere makePrivate applies the POSIX mode and answers false where it cannot', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-private-path-'));
    try {
      const file = path.join(home, 'secret');
      fs.writeFileSync(file, 'x');
      const applied = makePrivate(file, 0o600, { platform: 'linux' });
      if (process.platform !== 'win32') {
        assert.strictEqual(applied, true);
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
