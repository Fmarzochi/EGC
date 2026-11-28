/**
 * Tests for scripts/lib/team-config.js: the one reader and writer of
 * ~/.egc/team.json the hooks and the CLI share, and the autosync switch it
 * answers (#2059).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { teamConfigPath, readTeamConfig, isAutosyncOn, publishTeamConfigText, writeTeamConfig, makePrivate, privateAclArguments, windowsAccount } = require('../../scripts/lib/team-config');

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

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-team-config-'));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runTests() {
  console.log('\n=== Testing scripts/lib/team-config.js ===\n');
  const results = [
    test('the configuration lives at .egc/team.json under the given home', () => {
      assert.strictEqual(teamConfigPath('/h'), path.join('/h', '.egc', 'team.json'));
    }),

    test('a missing file, a file that is not JSON and a JSON that is not an object read as no configuration', () => withHome(home => {
      assert.strictEqual(readTeamConfig(home), null);
      fs.mkdirSync(path.join(home, '.egc'), { recursive: true });
      fs.writeFileSync(teamConfigPath(home), 'not json');
      assert.strictEqual(readTeamConfig(home), null);
      fs.writeFileSync(teamConfigPath(home), '["a"]');
      assert.strictEqual(readTeamConfig(home), null);
    })),

    test('autosync is on only when the configuration says true', () => withHome(home => {
      assert.strictEqual(isAutosyncOn(null), false, 'no team');
      assert.strictEqual(isAutosyncOn({ backend: 'git' }), false, 'no switch');
      assert.strictEqual(isAutosyncOn({ autosync: false }), false);
      assert.strictEqual(isAutosyncOn({ autosync: 'true' }), false, 'a string is not the switch');
      assert.strictEqual(isAutosyncOn({ autosync: true }), true);
      writeTeamConfig({ backend: 'git', remote: 'r', branch: 'main', teamKey: 'k', autosync: true }, home);
      assert.strictEqual(isAutosyncOn(readTeamConfig(home)), true, 'read back from the file');
    })),

    test('a write goes round trip, private, and a text goes back byte for byte', () => withHome(home => {
      const config = { backend: 'git', remote: 'https://example.test/r.git', branch: 'main', teamKey: 'a'.repeat(64) };
      writeTeamConfig(config, home);
      assert.deepStrictEqual(readTeamConfig(home), config);
      if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(teamConfigPath(home)).mode & 0o777, 0o600, 'the file holds the key, so it is private');
        assert.strictEqual(fs.statSync(path.dirname(teamConfigPath(home))).mode & 0o777, 0o700);
      }
      const previous = fs.readFileSync(teamConfigPath(home));
      writeTeamConfig({ ...config, autosync: true }, home);
      publishTeamConfigText(previous, home);
      assert.deepStrictEqual(fs.readFileSync(teamConfigPath(home)), previous);
      assert.deepStrictEqual(fs.readdirSync(path.dirname(teamConfigPath(home))), ['team.json'], 'no temporary is left behind');
    })),

    test('on Windows the file and the directory are kept to the user by an icacls ACL, since chmod changes nothing there', () => {
      assert.strictEqual(windowsAccount({ USERNAME: 'ana', USERDOMAIN: 'CASA' }), 'CASA\\ana', 'domain and user when the session names a domain');
      assert.strictEqual(windowsAccount({ USERNAME: 'ana' }), 'ana', 'the user alone otherwise');
      assert.deepStrictEqual(
        privateAclArguments('C:\\Users\\ana\\.egc\\team.json', { account: 'CASA\\ana' }),
        ['icacls', ['C:\\Users\\ana\\.egc\\team.json', '/inheritance:r', '/grant:r', 'CASA\\ana:F']],
        'a file: inheritance removed, one full-control entry'
      );
      assert.strictEqual(
        privateAclArguments('C:\\Users\\ana\\.egc', { directory: true, account: 'ana' })[1][3],
        'ana:(OI)(CI)F',
        'a directory: the entry is inherited by what it will hold'
      );
      const calls = [];
      const run = (command, args) => { calls.push([command, args]); return { status: 0 }; };
      assert.strictEqual(makePrivate('C:\\x\\team.json', 0o600, { platform: 'win32', run }), true);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0][0], 'icacls');
      assert.strictEqual(calls[0][1][0], 'C:\\x\\team.json');
      assert.strictEqual(calls[0][1][3].endsWith(':F'), true);
      assert.strictEqual(makePrivate('C:\\x', 0o700, { platform: 'win32', directory: true, run }), true);
      assert.strictEqual(calls[1][1][3].endsWith(':(OI)(CI)F'), true, 'the directory call carries the inheritance flags');
      assert.strictEqual(makePrivate('C:\\x\\team.json', 0o600, { platform: 'win32', run: () => ({ status: 5 }) }), false, 'a refused icacls is reported, not thrown');
      assert.strictEqual(makePrivate('C:\\x\\team.json', 0o600, { platform: 'win32', run: () => { throw new Error('no icacls'); } }), false, 'a missing icacls is reported, not thrown');
    }),

    test('elsewhere makePrivate applies the POSIX mode and answers false where modes cannot be set', () => withHome(home => {
      const file = path.join(home, 'secret');
      fs.writeFileSync(file, 'x');
      const applied = makePrivate(file, 0o600, { platform: 'linux' });
      if (process.platform !== 'win32') {
        assert.strictEqual(applied, true);
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      }
      assert.strictEqual(makePrivate(path.join(home, 'missing'), 0o600, { platform: 'linux' }), false, 'a path that is not there cannot be made private');
    })),
  ];

  const failed = results.filter(result => !result).length;
  console.log(`\nResults: Passed: ${results.length - failed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
