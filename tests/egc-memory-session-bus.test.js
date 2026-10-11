'use strict';
/**
 * Tests for mcp/servers/egc-memory/src/session-bus.ts
 *
 * Covers the Session Bus MVP invariants: presence with heartbeat, fail-fast
 * path claims, holder-only release, and lazy sweep of dead sessions freeing
 * their locks. Runs against an in-memory SQLite database using the memory
 * server's own driver; skips when the server build or driver is absent.
 *
 * Run with: node tests/egc-memory-session-bus.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const serverDir = path.join(__dirname, '..', 'mcp', 'servers', 'egc-memory');
const buildPath = path.join(serverDir, 'build', 'session-bus.js');

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-memory first.');
  process.exit(0);
}

let sqlite3;
let open;
try {
  sqlite3 = require(path.join(serverDir, 'node_modules', 'sqlite3'));
  ({ open } = require(path.join(serverDir, 'node_modules', 'sqlite')));
} catch {
  console.log('[SKIP] sqlite driver not installed. Run sh install.sh first.');
  process.exit(0);
}

const bus = require(buildPath);

function test(name, fn) {
  return fn().then(
    () => { console.log(`  PASS ${name}`); return true; },
    err => { console.log(`  FAIL ${name}`); console.log(`    ${err.message}`); return false; }
  );
}

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await bus.createSessionBusTables(db);
  return db;
}

async function main() {
  console.log('\n=== Testing egc-memory session bus ===\n');
  let passed = 0;
  let failed = 0;
  const run = async (name, fn) => { (await test(name, fn)) ? passed++ : failed++; };

  await run('announce registers presence and doubles as heartbeat', async () => {
    const db = await freshDb();
    await bus.announce(db, { sessionId: 's1', projectPath: '/p', territory: 'scripts/' });
    await bus.announce(db, { sessionId: 's1', projectPath: '/p' });
    const peers = await bus.listPeers(db, '/p');
    assert.strictEqual(peers.length, 1);
    assert.strictEqual(peers[0].territory, 'scripts/', 'territory survives heartbeat without territory');
  });

  await run('claim is fail-fast against a live holder', async () => {
    const db = await freshDb();
    await bus.announce(db, { sessionId: 's1', projectPath: '/p', territory: 'docs' });
    await bus.announce(db, { sessionId: 's2', projectPath: '/p' });
    const first = await bus.claimPath(db, { sessionId: 's1', path: 'src/index.ts' });
    assert.strictEqual(first.ok, true);
    const second = await bus.claimPath(db, { sessionId: 's2', path: 'src/index.ts' });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.holder, 's1');
    assert.strictEqual(second.holderTerritory, 'docs');
  });

  await run('a claim covers the tree under it: a path inside a held one, or above it, is refused', async () => {
    const db = await freshDb();
    await bus.announce(db, { sessionId: 's1', projectPath: '/p', territory: 'src' });
    await bus.announce(db, { sessionId: 's2', projectPath: '/p' });
    assert.strictEqual((await bus.claimPath(db, { sessionId: 's1', path: 'src' })).ok, true);
    const inside = await bus.claimPath(db, { sessionId: 's2', path: 'src/index.ts' });
    assert.strictEqual(inside.ok, false, 'a file inside a claimed directory');
    assert.strictEqual(inside.holder, 's1');
    assert.strictEqual(inside.holderTerritory, 'src');
    assert.strictEqual((await bus.claimPath(db, { sessionId: 's2', path: 'src2/a.ts' })).ok, true, 'a sibling that only shares a prefix');
    assert.strictEqual((await bus.claimPath(db, { sessionId: 's2', path: 'lib/a.ts' })).ok, true);
    const above = await bus.claimPath(db, { sessionId: 's1', path: 'lib' });
    assert.strictEqual(above.ok, false, 'a directory above a claimed file');
    assert.strictEqual(above.holder, 's2');
  });

  await run('a claim is held under the path it names, however it is spelled, in the project of the session', async () => {
    const db = await freshDb();
    await bus.announce(db, { sessionId: 's1', projectPath: '/p' });
    await bus.announce(db, { sessionId: 's2', projectPath: '/p' });
    await bus.announce(db, { sessionId: 's3', projectPath: '/q' });
    assert.strictEqual((await bus.claimPath(db, { sessionId: 's1', path: 'src/./a.ts' })).ok, true);
    for (const spelling of ['src/a.ts', './src/a.ts', 'src//a.ts', 'lib/../src/a.ts', path.join(path.resolve('/p'), 'src', 'a.ts')]) {
      const claim = await bus.claimPath(db, { sessionId: 's2', path: spelling });
      assert.strictEqual(claim.ok, false, spelling);
    }
    assert.strictEqual((await bus.claimPath(db, { sessionId: 's3', path: 'src/a.ts' })).ok, true, 'the same words in another project are another file');
    assert.strictEqual((await bus.claimPath(db, { sessionId: 's1', path: 'docs/' })).ok, true);
    assert.strictEqual((await bus.claimPath(db, { sessionId: 's2', path: 'docs' })).ok, false, 'a trailing separator names the same directory');
    assert.strictEqual(await bus.releasePath(db, { sessionId: 's1', path: './src/a.ts' }), true, 'released by another spelling');
    assert.strictEqual((await bus.claimPath(db, { sessionId: 's2', path: 'src/a.ts' })).ok, true);
  });

  await run('a claim above or inside a lock from a vanished session is not blocked, and the stale lock goes', async () => {
    const db = await freshDb();
    await bus.announce(db, { sessionId: 'alive', projectPath: '/p' });
    await db.run(
      'INSERT INTO bus_locks (path, session_id, acquired_at, ttl_seconds) VALUES (?, ?, ?, 900)',
      path.join(path.resolve('/p'), 'src'), 'ghost', new Date().toISOString()
    );
    assert.strictEqual((await bus.claimPath(db, { sessionId: 'alive', path: 'src/index.ts' })).ok, true);
    assert.deepStrictEqual((await bus.listLocks(db)).map(lock => lock.session_id), ['alive']);
  });

  await run('two overlapping claims taken at the same moment: the tie goes to the session id that sorts first', async () => {
    const db = await freshDb();
    await bus.announce(db, { sessionId: 'first', projectPath: '/p' });
    await bus.announce(db, { sessionId: 'second', projectPath: '/p' });
    const root = path.resolve('/p');
    await db.run('INSERT INTO bus_locks (path, session_id, acquired_at, ttl_seconds) VALUES (?, ?, ?, 900)', path.join(root, 'src'), 'first', '2026-09-28T00:00:00.000Z');
    await db.run('INSERT INTO bus_locks (path, session_id, acquired_at, ttl_seconds) VALUES (?, ?, ?, 900)', path.join(root, 'src', 'a.ts'), 'second', '2026-09-28T00:00:00.000Z');
    const second = await bus.claimPath(db, { sessionId: 'second', path: 'src/a.ts' }, Date.parse('2026-09-28T00:00:01.000Z'));
    assert.strictEqual(second.ok, false, 'the later claim of the pair yields');
    assert.strictEqual(second.holder, 'first');
    assert.deepStrictEqual((await bus.listLocks(db)).map(lock => lock.session_id), ['first'], 'its row is gone');
  });

  await run('of two overlapping claims held at once, the earlier one stays', async () => {
    const db = await freshDb();
    await bus.announce(db, { sessionId: 'b', projectPath: '/p' });
    await bus.announce(db, { sessionId: 'a', projectPath: '/p' });
    const root = path.resolve('/p');
    await db.run('INSERT INTO bus_locks (path, session_id, acquired_at, ttl_seconds) VALUES (?, ?, ?, 900)', path.join(root, 'src'), 'b', '2026-09-28T00:00:00.000Z');
    await db.run('INSERT INTO bus_locks (path, session_id, acquired_at, ttl_seconds) VALUES (?, ?, ?, 900)', path.join(root, 'src', 'a.ts'), 'a', '2026-09-28T00:00:05.000Z');
    const earlier = await bus.claimPath(db, { sessionId: 'b', path: 'src' }, Date.parse('2026-09-28T00:00:06.000Z'));
    assert.strictEqual(earlier.ok, true, 'the earlier holder keeps its claim');
    const later = await bus.claimPath(db, { sessionId: 'a', path: 'src/a.ts' }, Date.parse('2026-09-28T00:00:07.000Z'));
    assert.strictEqual(later.ok, false);
    assert.deepStrictEqual((await bus.listLocks(db)).map(lock => lock.session_id), ['b']);
  });

  await run('a claim another session lands between the check and the write makes the later one yield', async () => {
    const db = await freshDb();
    await bus.announce(db, { sessionId: 'racer', projectPath: '/p' });
    await bus.announce(db, { sessionId: 'me', projectPath: '/p' });
    const root = path.resolve('/p');
    let landed = false;
    const racing = {
      run: async (sql, ...params) => {
        if (!landed && /INSERT OR IGNORE INTO bus_locks/.test(sql)) {
          landed = true;
          await db.run('INSERT INTO bus_locks (path, session_id, acquired_at, ttl_seconds) VALUES (?, ?, ?, 900)', path.join(root, 'src'), 'racer', '2026-01-01T00:00:00.000Z');
        }
        return db.run(sql, ...params);
      },
      get: (...args) => db.get(...args),
      all: (...args) => db.all(...args),
      exec: (...args) => db.exec(...args),
    };
    const claim = await bus.claimPath(racing, { sessionId: 'me', path: 'src/a.ts' });
    assert.strictEqual(claim.ok, false, 'the claim that landed later yields');
    assert.strictEqual(claim.holder, 'racer');
    assert.deepStrictEqual((await bus.listLocks(db)).map(lock => lock.session_id), ['racer']);
  });

  await run('a holder that renews its claim beside a later overlapping one keeps it and extends its lifetime, and keeps its place in the order', async () => {
    const db = await freshDb();
    await bus.announce(db, { sessionId: 'b', projectPath: '/p' });
    await bus.announce(db, { sessionId: 'a', projectPath: '/p' });
    const root = path.resolve('/p');
    await db.run('INSERT INTO bus_locks (path, session_id, acquired_at, ttl_seconds) VALUES (?, ?, ?, 60)', path.join(root, 'src'), 'b', '2026-09-28T00:00:00.000Z');
    await db.run('INSERT INTO bus_locks (path, session_id, acquired_at, ttl_seconds) VALUES (?, ?, ?, 900)', path.join(root, 'src', 'a.ts'), 'a', '2026-09-28T00:00:05.000Z');
    const renewed = await bus.claimPath(db, { sessionId: 'b', path: 'src', ttlSeconds: 600 }, Date.parse('2026-09-28T00:01:00.000Z'));
    assert.strictEqual(renewed.ok, true);
    const row = await db.get('SELECT acquired_at, ttl_seconds FROM bus_locks WHERE session_id = ?', 'b');
    assert.strictEqual(row.acquired_at, '2026-09-28T00:00:00.000Z', 'the time it was first taken is kept');
    assert.strictEqual(row.ttl_seconds, 660, 'it lives 600 s from the renewal');
    assert.strictEqual((await bus.claimPath(db, { sessionId: 'a', path: 'src/a.ts' }, Date.parse('2026-09-28T00:01:01.000Z'))).ok, false, 'the later overlapping claim still yields');
  });

  await run('a claim of the file system root or of a directory above the project is refused with its reason', async () => {
    const db = await freshDb();
    const project = path.resolve('/p/app');
    await bus.announce(db, { sessionId: 's1', projectPath: project });
    for (const wide of ['../../../..', '/', '..', path.dirname(project)]) {
      const claim = await bus.claimPath(db, { sessionId: 's1', path: wide });
      assert.strictEqual(claim.ok, false, wide);
      assert.match(claim.reason, /root of the file system|whole project/, wide);
    }
    assert.strictEqual((await bus.claimPath(db, { sessionId: 's1', path: '.' })).ok, true, 'the project itself can be claimed');
    assert.strictEqual((await bus.claimPath(db, { sessionId: 's1', path: '../sibling/file' })).ok, true, 'a path beside the project covers only itself');
    assert.strictEqual((await bus.listLocks(db)).length, 2);
    const loose = await bus.claimPath(db, { sessionId: 'never-announced', path: path.parse(project).root });
    assert.strictEqual(loose.ok, false, 'the root is refused to a session without a project too');
    assert.match(loose.reason, /root of the file system/);
  });

  await run('a key is kept in one case where the file system ignores case', async () => {
    assert.strictEqual(bus.claimKeyOf('/P/App', 'Src/A.ts', 'win32'), bus.claimKeyOf('/p/app', 'src/a.ts', 'win32'));
    assert.strictEqual(bus.claimKeyOf('/P/App', 'Src', 'darwin'), path.resolve('/p/app/src'));
    assert.notStrictEqual(bus.claimKeyOf('/P/App', 'Src', 'linux'), bus.claimKeyOf('/p/app', 'src', 'linux'));
    assert.ok(bus.claimsOverlap(bus.claimKeyOf('/P', 'SRC', 'darwin'), bus.claimKeyOf('/p', 'src/x.ts', 'darwin')));
  });

  await run('holder can re-claim its own path and only the holder releases', async () => {
    const db = await freshDb();
    await bus.announce(db, { sessionId: 's1', projectPath: '/p' });
    await bus.claimPath(db, { sessionId: 's1', path: 'a.js' });
    const reclaim = await bus.claimPath(db, { sessionId: 's1', path: 'a.js' });
    assert.strictEqual(reclaim.ok, true);
    assert.strictEqual(await bus.releasePath(db, { sessionId: 's2', path: 'a.js' }), false);
    assert.strictEqual(await bus.releasePath(db, { sessionId: 's1', path: 'a.js' }), true);
    assert.strictEqual((await bus.listLocks(db)).length, 0);
  });

  await run('dead sessions are swept and their locks freed', async () => {
    const db = await freshDb();
    const past = Date.now() - (bus.SESSION_TTL_SECONDS + 60) * 1000;
    await bus.announce(db, { sessionId: 'dead', projectPath: '/p' }, past);
    await bus.claimPath(db, { sessionId: 'dead', path: 'x.js' }, past);
    await bus.announce(db, { sessionId: 'alive', projectPath: '/p' });
    await bus.sweepDead(db);
    const peers = await bus.listPeers(db);
    assert.strictEqual(peers.length, 1);
    assert.strictEqual(peers[0].id, 'alive');
    const claim = await bus.claimPath(db, { sessionId: 'alive', path: 'x.js' });
    assert.strictEqual(claim.ok, true, 'lock freed by sweep is claimable');
  });

  await run('a lock past its ttl is swept by the clock the sweep is given, not by the database clock (#1681)', async () => {
    const db = await freshDb();
    await bus.announce(db, { sessionId: 'holder', projectPath: '/p' });
    const claim = await bus.claimPath(db, { sessionId: 'holder', path: 'y.js', ttlSeconds: 60 });
    assert.strictEqual(claim.ok, true);
    const later = Date.now() + 120 * 1000;
    await bus.announce(db, { sessionId: 'holder', projectPath: '/p' }, later);
    await bus.sweepDead(db, later);
    assert.strictEqual((await bus.listLocks(db)).length, 0, 'a lock 120 s old by the given clock, with a 60 s ttl, is gone');
  });

  await run('a direct event reaches only a live session of the same project', async () => {
    const db = await freshDb();
    await bus.announce(db, { sessionId: 'a', projectPath: '/p' });
    await bus.announce(db, { sessionId: 'b', projectPath: '/other' });
    await bus.announce(db, { sessionId: 'c', projectPath: '/p' });
    const across = await bus.sendEvent(db, { fromSession: 'a', toSession: 'b', projectPath: '/p', kind: 'handoff', payload: 'x' });
    assert.strictEqual(across.ok, false);
    assert.match(across.reason, /not live in this project/);
    const unscoped = await bus.sendEvent(db, { fromSession: 'a', toSession: 'c', kind: 'handoff', payload: 'x' });
    assert.strictEqual(unscoped.ok, false, 'a sender without a project reaches no session of one');
    assert.strictEqual((await db.all('SELECT id FROM bus_events')).length, 0, 'nothing is queued for a session of another project');
    const within = await bus.sendEvent(db, { fromSession: 'a', toSession: 'c', projectPath: '/p', kind: 'handoff', payload: 'kept' });
    assert.strictEqual(within.ok, true);
    const queued = await db.all('SELECT from_session, to_session, project_path FROM bus_events');
    assert.deepStrictEqual(queued.map(e => ({ ...e })), [{ from_session: 'a', to_session: 'c', project_path: '/p' }]);
    const delivered = await bus.readEvents(db, { sessionId: 'c', projectPath: '/p' });
    assert.deepStrictEqual(delivered.map(e => e.payload), ['kept']);
  });

  await run('a lock from a vanished session does not block a live claim', async () => {
    const db = await freshDb();
    await bus.announce(db, { sessionId: 'alive', projectPath: '/p' });
    await db.run(
      "INSERT INTO bus_locks (path, session_id, acquired_at, ttl_seconds) VALUES ('y.js', 'ghost', ?, 900)",
      new Date().toISOString()
    );
    const claim = await bus.claimPath(db, { sessionId: 'alive', path: 'y.js' });
    assert.strictEqual(claim.ok, true);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[FAIL]', err);
  process.exit(1);
});
