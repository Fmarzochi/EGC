'use strict';
/**
 * withBuildLock guards the code graph database under ~/.egc/graph/. A stale
 * lock (left by a process that died) is broken once. Two processes can both
 * find the same stale lock. The loser of that race must not remove the
 * winner's fresh lock and take it too, or two builders write the same
 * database at once.
 *
 * The interleaving is forced: the winner breaks the stale lock and takes it
 * in the middle of the loser's own break. Run with:
 * node tests/egc-guardian-graph-lock.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-guardian', 'build');
if (!fs.existsSync(path.join(buildDir, 'graph-build.js'))) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-guardian first.');
  process.exit(0);
}
const { withBuildLock } = require(path.join(buildDir, 'graph-build.js'));

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.stack || err.message}`);
    failed++;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-graph-lock-'));
const staleAt = new Date(Date.now() - 10 * 60 * 1000);

(async () => {
  await run('a stale lock is broken and the caller takes the lock', async () => {
    const db = path.join(tmp, 'stale-only', 'g.db');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(`${db}.lock`, 'dead-owner');
    fs.utimesSync(`${db}.lock`, staleAt, staleAt);
    const r = await withBuildLock(db, async () => 'built');
    assert.deepStrictEqual(r, { ran: true, value: 'built' });
    assert.ok(!fs.existsSync(`${db}.lock`), 'the lock is released');
  });

  await run('the loser of the stale-lock race is refused, and the winner\'s lock is left intact', async () => {
    const db = path.join(tmp, 'race', 'g.db');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    const lock = `${db}.lock`;
    fs.writeFileSync(lock, 'dead-owner');
    fs.utimesSync(lock, staleAt, staleAt);

    const realRename = fs.renameSync;
    const winnerToken = 'winner-token';
    let loserRan = false;
    let interleaved = false;
    fs.renameSync = (from, to) => {
      if (from === lock && !interleaved) {
        interleaved = true;
        // The winner breaks the stale lock and takes the lock first...
        const winnerMoved = `${lock}.winner-moved`;
        realRename(from, winnerMoved);
        fs.writeFileSync(lock, winnerToken, { flag: 'wx' });
        fs.rmSync(winnerMoved, { force: true });
      }
      // ...then the loser's own break runs against the winner's fresh lock.
      return realRename(from, to);
    };
    try {
      const r = await withBuildLock(db, async () => {
        loserRan = true;
        return 'loser built';
      });
      assert.deepStrictEqual(r, { ran: false }, 'the loser is refused');
      assert.strictEqual(loserRan, false, 'the loser does not build');
      assert.strictEqual(fs.readFileSync(lock, 'utf8'), winnerToken, 'the winner still holds the lock');
    } finally {
      fs.renameSync = realRename;
      fs.rmSync(lock, { force: true });
    }
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
