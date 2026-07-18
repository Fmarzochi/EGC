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
