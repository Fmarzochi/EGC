/**
 * The floor between two automatic pulls of one machine (scripts/lib/team-autosync.js):
 * several tabs opening at once pull once, a push is paced by the state alone,
 * and a pull after the floor runs again. Runs against a home of its own.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pullTooSoon, wouldSync, claimPull, releasePull, PULL_FLOOR_MS } = require('../../scripts/lib/team-autosync');

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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-autosync-floor-'));
fs.mkdirSync(path.join(home, '.egc'), { recursive: true });
fs.writeFileSync(path.join(home, '.egc', 'team.json'), JSON.stringify({ backend: 'git', remote: 'https://example.invalid/team.git', branch: 'main', teamKey: 'ab'.repeat(32), autosync: true }));
const stamp = (lastRun, reason) => fs.writeFileSync(path.join(home, '.egc', 'team-autosync.json'), JSON.stringify({ lastRun, reason, ok: true, detail: 'ok' }));
const stampFull = value => fs.writeFileSync(path.join(home, '.egc', 'team-autosync.json'), JSON.stringify(value));

try {
  test('a pull right after another automatic pull is too soon, and wouldSync says so', () => {
    stamp(new Date().toISOString(), 'session-start');
    assert.strictEqual(pullTooSoon(home, 'session-start'), true);
    assert.strictEqual(wouldSync({ homeDir: home, reason: 'session-start' }), false);
  });

  test('a push is never held by the floor, and a pull after a push is not either', () => {
    stamp(new Date().toISOString(), 'session-start');
    assert.strictEqual(pullTooSoon(home, 'session-end'), false);
    stamp(new Date().toISOString(), 'session-end');
    assert.strictEqual(pullTooSoon(home, 'session-start'), false);
    assert.strictEqual(wouldSync({ homeDir: home, reason: 'session-start' }), true);
  });

  test('a pull after the floor runs again, and a machine without a run has no floor', () => {
    stamp(new Date(Date.now() - PULL_FLOOR_MS - 1000).toISOString(), 'session-start');
    assert.strictEqual(pullTooSoon(home, 'session-start'), false);
    fs.rmSync(path.join(home, '.egc', 'team-autosync.json'), { force: true });
    assert.strictEqual(pullTooSoon(home, 'session-start'), false);
  });

  test('a push keeps the record of the last pull, so the floor still holds after it', () => {
    const now = new Date().toISOString();
    stampFull({ lastRun: now, reason: 'session-end', ok: true, detail: 'pushed', lastPull: now });
    assert.strictEqual(pullTooSoon(home, 'session-start'), true, 'the pull a moment ago counts after a push wrote the stamp');
    stampFull({ lastRun: now, reason: 'session-end', ok: true, detail: 'pushed', lastPull: new Date(Date.now() - PULL_FLOOR_MS - 1000).toISOString() });
    assert.strictEqual(pullTooSoon(home, 'session-start'), false, 'a pull older than the floor does not hold the next');
  });

  test('one session holds the pull claim at a time, and the claim of a session that died is taken over', () => {
    const claim = path.join(home, '.egc', 'team-autosync.pull');
    assert.strictEqual(claimPull(home), true, 'the first claim is taken');
    assert.strictEqual(claimPull(home), false, 'a second session finds it held');
    releasePull(home);
    assert.ok(!fs.existsSync(claim), 'released, the claim is gone');
    assert.strictEqual(claimPull(home), true, 'and is taken again');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(claim, old, old);
    assert.strictEqual(claimPull(home), true, 'a claim left by a session that died is taken over');
    releasePull(home);
  });
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
