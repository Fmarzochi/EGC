/**
 * The Team Brain sync at the turn boundary (scripts/lib/team-autosync-turn.js):
 * the first turn of a session syncs whole and marks the session, the later
 * turns push only what changed, a first sync that could not run is tried
 * again, and the mark is named by a hash of the raw session id. The sync
 * itself is replaced by a stub; the real run is covered by the mesh notice
 * tests. Runs against a home of its own.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { turnSync, markKey } = require('../../scripts/lib/team-autosync-turn');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-turn-sync-'));
fs.mkdirSync(path.join(home, '.egc'), { recursive: true });
const team = on => fs.writeFileSync(path.join(home, '.egc', 'team.json'), JSON.stringify({ backend: 'git', remote: 'https://example.invalid/team.git', branch: 'main', teamKey: 'ab'.repeat(32), ...(on ? { autosync: true } : {}) }));
const mark = id => path.join(home, '.egc', 'mesh', `team-pull-${markKey(id)}.json`);
const calls = [];
const stub = outcome => (homeDir, reason, onlyIfStateChanged) => {
  calls.push({ reason, onlyIfStateChanged });
  return outcome;
};
const lastCall = () => calls.at(-1);

try {
  test('with the switch off nothing runs and nothing is marked', () => {
    team(false);
    assert.deepStrictEqual(turnSync({ sessionId: 's1', homeDir: home, run: stub({ ran: true, ok: true }) }), { ran: false, why: 'off' });
    assert.strictEqual(calls.length, 0);
    assert.ok(!fs.existsSync(mark('s1')));
  });

  test('the first turn of a session syncs whole and marks the session; the later turns push only what changed', () => {
    team(true);
    assert.strictEqual(turnSync({ sessionId: 's1', homeDir: home, run: stub({ ran: true, ok: true, detail: 'pulled 1 files, pushed 0 commits' }) }).ran, true);
    assert.deepStrictEqual(lastCall(), { reason: 'turn-start', onlyIfStateChanged: false });
    assert.ok(fs.existsSync(mark('s1')), 'the session is marked');
    turnSync({ sessionId: 's1', homeDir: home, run: stub({ ran: false, why: 'unchanged' }) });
    assert.deepStrictEqual(lastCall(), { reason: 'turn', onlyIfStateChanged: true });
  });

  test('a first sync the server or the budget denied leaves no mark, so the next prompt tries again; another session pulling counts as ours', () => {
    turnSync({ sessionId: 's2', homeDir: home, run: stub({ ran: false, why: 'no-server' }) });
    assert.ok(!fs.existsSync(mark('s2')), 'not marked when the server was not found');
    turnSync({ sessionId: 's2', homeDir: home, run: stub({ ran: false, why: 'timeout' }) });
    assert.ok(!fs.existsSync(mark('s2')), 'not marked when the budget was spent');
    assert.deepStrictEqual(lastCall(), { reason: 'turn-start', onlyIfStateChanged: false }, 'the next prompt tries the first sync again');
    turnSync({ sessionId: 's2', homeDir: home, run: stub({ ran: false, why: 'too-soon' }) });
    assert.ok(fs.existsSync(mark('s2')), 'marked when another session of this machine was pulling at that moment');
  });

  test('two sessions never share a mark, a link at the name is nobody\'s mark, and an anonymous session syncs whole again after ten minutes', () => {
    assert.notStrictEqual(markKey('a/b'), markKey('a_b'), 'ids the notice cache would flatten alike keep marks apart');
    assert.strictEqual(markKey(''), 'anon');
    assert.strictEqual(markKey(undefined), 'anon');
    fs.mkdirSync(path.join(home, '.egc', 'mesh'), { recursive: true });
    const victim = path.join(home, 'victim.txt');
    fs.writeFileSync(victim, 'keep');
    // A platform that refuses links to this process skips the link case;
    // any other failure is a failure.
    let linked = true;
    try {
      fs.symlinkSync(victim, mark('s3'));
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
      linked = false;
    }
    if (linked) {
      turnSync({ sessionId: 's3', homeDir: home, run: stub({ ran: true, ok: true }) });
      assert.deepStrictEqual(lastCall(), { reason: 'turn-start', onlyIfStateChanged: false }, 'a link is not a mark: the session syncs whole');
      assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep', 'the file behind the link is untouched');
      assert.ok(fs.lstatSync(mark('s3')).isFile(), 'the mark replaced the link');
    }
    turnSync({ homeDir: home, run: stub({ ran: true, ok: true }) });
    assert.ok(fs.existsSync(mark('')), 'an anonymous session is marked under anon');
    turnSync({ homeDir: home, run: stub({ ran: true, ok: true }) });
    assert.deepStrictEqual(lastCall(), { reason: 'turn', onlyIfStateChanged: true }, 'and pushes only what changed while the mark is fresh');
    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(mark(''), old, old);
    turnSync({ homeDir: home, run: stub({ ran: true, ok: true }) });
    assert.deepStrictEqual(lastCall(), { reason: 'turn-start', onlyIfStateChanged: false }, 'after ten minutes it syncs whole again');
  });
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
