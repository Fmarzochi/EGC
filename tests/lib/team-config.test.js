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

const { teamConfigPath, readTeamConfig, isAutosyncOn, publishTeamConfigText, writeTeamConfig } = require('../../scripts/lib/team-config');

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
  ];

  const failed = results.filter(result => !result).length;
  console.log(`\nResults: Passed: ${results.length - failed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
