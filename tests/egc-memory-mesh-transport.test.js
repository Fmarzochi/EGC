'use strict';
/**
 * Tests for mcp/servers/egc-memory/src/mesh-transport.ts
 *
 * Mesh v0 (design #1251, layer C2): the wake-on-write transport behind
 * EGC_MESH_PUSH. The watcher is a wake signal only, so these tests assert
 * the contract that matters: a waiter wakes on a write to the store's -wal
 * file, unrelated files do not wake it, close() strands nobody, the interval
 * fallback engages when fs.watch is unavailable, and wake-on-write composes
 * with the real session-bus cursor semantics end to end (ordered, no loss,
 * no duplicates) across two live sqlite connections to the same store.
 *
 * Compiles the real src/ modules via tests/lib/egc-memory-src.js and skips
 * cleanly when the TypeScript compiler or the sqlite driver is not reachable
 * from the root or the server's node_modules (yarn's linker hoists neither).
 *
 * Run with: node tests/egc-memory-mesh-transport.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTypescript, loadSqliteDriver, compileMemoryModule } = require('./lib/egc-memory-src');

const ts = loadTypescript();
if (!ts) {
  console.log('[SKIP] typescript not resolvable from the root or server node_modules.');
  process.exit(0);
}
const mesh = compileMemoryModule('mesh-transport', ts);

function test(name, fn) {
  return fn().then(
    () => { console.log(`  PASS ${name}`); return true; },
    err => { console.log(`  FAIL ${name}`); console.log(`    ${err.message}`); return false; }
  );
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-mesh-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

async function main() {
  console.log('\n=== Testing egc-memory mesh transport (v0) ===\n');
  let passed = 0;
  let failed = 0;
  const run = async (name, fn) => { (await test(name, fn)) ? passed++ : failed++; };

  await run('meshPushEnabled defaults ON and honors only the exact opt-out value', async () => {
    assert.strictEqual(mesh.meshPushEnabled({ EGC_MESH_PUSH: '0' }), false);
    assert.strictEqual(mesh.meshPushEnabled({ EGC_MESH_PUSH: 'true' }), true);
    assert.strictEqual(mesh.meshPushEnabled({ EGC_MESH_PUSH: '1' }), true);
    assert.strictEqual(mesh.meshPushEnabled({}), true);
  });

  await run('a waiter wakes on an append to the -wal file', async () => {
    await withTempDir(async dir => {
      const dbPath = path.join(dir, 'state.db');
      const transport = mesh.createMeshTransport({ dbPath });
      try {
        assert.strictEqual(transport.mode, 'watch');
        const started = Date.now();
        const wake = transport.waitForChange(5000);
        // A single append can land inside FSEvents' stream warm-up window on
        // a fresh watcher and get dropped (the exact macOS-runner race the
        // #1277 deadline fix documented), so keep appending until the waiter
        // wakes: production writes to the bus repeat too, and correctness
        // comes from the caller's re-read, never from one delivery.
        fs.appendFileSync(`${dbPath}-wal`, 'append');
        const appender = setInterval(() => {
          try { fs.appendFileSync(`${dbPath}-wal`, 'append'); } catch { /* dir gone on teardown */ }
        }, 250);
        let reason;
        try {
          reason = await wake;
        } finally {
          clearInterval(appender);
        }
        const elapsed = Date.now() - started;
        assert.strictEqual(reason, 'change');
        assert.ok(elapsed < 4500, `wake took ${elapsed}ms, expected < 4500ms`);
        console.log(`    (wake latency: ${elapsed}ms)`);
      } finally {
        transport.close();
      }
    });
  });

  await run('unrelated files in the store directory do not wake waiters', async () => {
    await withTempDir(async dir => {
      const dbPath = path.join(dir, 'state.db');
      const transport = mesh.createMeshTransport({ dbPath });
      try {
        const wake = transport.waitForChange(400);
        fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'noise');
        fs.writeFileSync(`${dbPath}.backup`, 'cousin, not a sidecar');
        const reason = await wake;
        if (process.platform === 'linux') {
          // inotify always delivers the filename, so the tight name filter
          // must hold exactly: neither file above is db or a `-` sidecar.
          assert.strictEqual(reason, 'timeout');
        } else {
          // Platforms may deliver a null filename, which legitimately wakes
          // the waiter: waking on too much is the safe side of the contract.
          assert.ok(reason === 'timeout' || reason === 'change', `unexpected reason ${reason}`);
        }
      } finally {
        transport.close();
      }
    });
  });

  await run('close() resolves pending waiters and later calls return closed', async () => {
    await withTempDir(async dir => {
      const transport = mesh.createMeshTransport({ dbPath: path.join(dir, 'state.db') });
      const pending = transport.waitForChange(10000);
      assert.strictEqual(transport.pendingWaiters(), 1);
      transport.close();
      assert.strictEqual(await pending, 'closed');
      assert.strictEqual(transport.pendingWaiters(), 0);
      transport.close();
      assert.strictEqual(await transport.waitForChange(10), 'closed');
    });
  });

  await run('interval fallback engages when fs.watch is unavailable', async () => {
    await withTempDir(async dir => {
      const transport = mesh.createMeshTransport({
        dbPath: path.join(dir, 'state.db'),
        watchImpl: () => { throw new Error('watch unsupported here'); }
      });
      try {
        assert.strictEqual(transport.mode, 'interval');
        const started = Date.now();
        assert.strictEqual(await transport.waitForChange(150), 'timeout');
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 100 && elapsed < 1500, `interval round took ${elapsed}ms`);
      } finally {
        transport.close();
      }
    });
  });

  const driver = loadSqliteDriver();
  if (!driver) {
    console.log('[SKIP] sqlite driver not resolvable; end-to-end bus delivery not exercised.');
  } else {
    await run('wake-on-write delivers real bus events in order, no loss, no duplicates', async () => {
      await withTempDir(async dir => {
        const bus = compileMemoryModule('session-bus', ts);
        const dbPath = path.join(dir, 'state.db');
        const writerDb = await driver.open({ filename: dbPath, driver: driver.sqlite3.Database });
        const readerDb = await driver.open({ filename: dbPath, driver: driver.sqlite3.Database });
        const transport = mesh.createMeshTransport({ dbPath });
        try {
          for (const db of [writerDb, readerDb]) {
            await db.exec('PRAGMA journal_mode = WAL;');
            await db.exec('PRAGMA busy_timeout = 5000;');
          }
          await bus.createSessionBusTables(writerDb);
          await bus.announce(writerDb, { sessionId: 'mesh-a', projectPath: '/p' });
          await bus.announce(writerDb, { sessionId: 'mesh-b', projectPath: '/p' });

          const TOTAL = 5;
          const received = [];
          const reader = (async () => {
            const deadline = Date.now() + 10000;
            while (received.length < TOTAL && Date.now() < deadline) {
              const events = await bus.readEvents(readerDb, { sessionId: 'mesh-b' });
              received.push(...events);
              if (received.length >= TOTAL) break;
              await transport.waitForChange(Math.min(500, Math.max(1, deadline - Date.now())));
            }
            return received;
          })();

          for (let i = 1; i <= TOTAL; i++) {
            const sent = await bus.sendEvent(writerDb, {
              fromSession: 'mesh-a', toSession: 'mesh-b', kind: 'seq', payload: String(i)
            });
            assert.strictEqual(sent.ok, true, `send ${i} accepted`);
          }

          const started = Date.now();
          await reader;
          const elapsed = Date.now() - started;
          assert.strictEqual(received.length, TOTAL, `expected ${TOTAL} events, got ${received.length}`);
          const payloads = received.map(e => Number(e.payload));
          assert.deepStrictEqual(payloads, [1, 2, 3, 4, 5], 'sender order preserved');
          const ids = new Set(received.map(e => e.id));
          assert.strictEqual(ids.size, TOTAL, 'no duplicate deliveries');
          const drained = await bus.readEvents(readerDb, { sessionId: 'mesh-b' });
          assert.strictEqual(drained.length, 0, 'cursor advanced: nothing re-delivered');
          console.log(`    (end-to-end drain completed ${elapsed}ms after last send)`);
        } finally {
          transport.close();
          await readerDb.close();
          await writerDb.close();
        }
      });
    });

    await run('a waiter parked before the write is pushed awake by the write itself', async () => {
      await withTempDir(async dir => {
        const bus = compileMemoryModule('session-bus', ts);
        const dbPath = path.join(dir, 'state.db');
        const db = await driver.open({ filename: dbPath, driver: driver.sqlite3.Database });
        const transport = mesh.createMeshTransport({ dbPath });
        try {
          await db.exec('PRAGMA journal_mode = WAL;');
          await bus.createSessionBusTables(db);
          await bus.announce(db, { sessionId: 'mesh-a', projectPath: '/p' });
          await bus.announce(db, { sessionId: 'mesh-b', projectPath: '/p' });

          const wake = transport.waitForChange(8000);
          await bus.sendEvent(db, { fromSession: 'mesh-a', toSession: 'mesh-b', kind: 'ping' });
          // A single write can land inside FSEvents' stream warm-up window on
          // a fresh watcher and get dropped (the exact macOS-runner race the
          // #1277 deadline fix and the fresh-watcher append fix documented),
          // so keep the bus moving with neutral heartbeat re-announces until
          // the waiter wakes: production sessions keep writing too, and the
          // delivery assert below reads the bus, never one wake.
          const heartbeat = setInterval(() => {
            bus.announce(db, { sessionId: 'mesh-a', projectPath: '/p' }).catch(() => {});
          }, 250);
          let reason;
          try {
            reason = await wake;
          } finally {
            clearInterval(heartbeat);
          }
          assert.strictEqual(reason, 'change', 'sqlite write woke the parked waiter');
          const events = await bus.readEvents(db, { sessionId: 'mesh-b' });
          assert.strictEqual(events.length, 1);
          assert.strictEqual(events[0].kind, 'ping');
        } finally {
          transport.close();
          await db.close();
        }
      });
    });

    await run('waitForBusEvents parks write-free: no self-waking storm', async () => {
      await withTempDir(async dir => {
        const bus = compileMemoryModule('session-bus', ts);
        const dbPath = path.join(dir, 'state.db');
        const db = await driver.open({ filename: dbPath, driver: driver.sqlite3.Database });
        const transport = mesh.createMeshTransport({ dbPath });
        try {
          await db.exec('PRAGMA journal_mode = WAL;');
          await bus.createSessionBusTables(db);
          const readFresh = async () => {
            await bus.announce(db, { sessionId: 'mesh-b', projectPath: '/p' });
            return bus.readEvents(db, { sessionId: 'mesh-b' });
          };
          const readQuiet = () => bus.readEvents(db, { sessionId: 'mesh-b' });
          const result = await mesh.waitForBusEvents({
            transport, readFresh, readQuiet, timeoutMs: 1200, repollCeilingMs: 400
          });
          assert.strictEqual(result.events.length, 0);
          assert.ok(result.waitedMs >= 1100, `waited ${result.waitedMs}ms, expected ~1200`);
          // A loop whose re-reads write to the store would retrigger its own
          // watcher every debounce tick (~25ms: dozens of rounds in 1200ms).
          // A write-free park sees only the initial announce's spurious wake
          // plus the repoll-ceiling rounds (1200 / 400 = 3).
          assert.ok(result.rounds <= 6, `expected a parked wait, saw ${result.rounds} rounds`);
        } finally {
          transport.close();
          await db.close();
        }
      });
    });

    await run('waitForBusEvents wakes and delivers on a mid-wait send', async () => {
      await withTempDir(async dir => {
        const bus = compileMemoryModule('session-bus', ts);
        const dbPath = path.join(dir, 'state.db');
        const db = await driver.open({ filename: dbPath, driver: driver.sqlite3.Database });
        const transport = mesh.createMeshTransport({ dbPath });
        try {
          await db.exec('PRAGMA journal_mode = WAL;');
          await bus.createSessionBusTables(db);
          await bus.announce(db, { sessionId: 'mesh-a', projectPath: '/p' });
          await bus.announce(db, { sessionId: 'mesh-b', projectPath: '/p' });
          const sendLater = new Promise((resolve, reject) => setTimeout(() => {
            bus.sendEvent(db, { fromSession: 'mesh-a', toSession: 'mesh-b', kind: 'late', payload: 'x' })
              .then(sent => {
                assert.strictEqual(sent.ok, true, 'mid-wait send accepted');
                resolve();
              })
              .catch(reject);
          }, 150));
          const result = await mesh.waitForBusEvents({
            transport,
            readFresh: () => bus.readEvents(db, { sessionId: 'mesh-b' }),
            readQuiet: () => bus.readEvents(db, { sessionId: 'mesh-b' }),
            timeoutMs: 8000
          });
          await sendLater;
          assert.strictEqual(result.events.length, 1);
          assert.strictEqual(result.events[0].kind, 'late');
          assert.ok(result.waitedMs < 3000, `delivered ${result.waitedMs}ms after the wait began`);
        } finally {
          transport.close();
          await db.close();
        }
      });
    });
  }

  await run('no watcher survives close()', async () => {
    await withTempDir(async dir => {
      const dbPath = path.join(dir, 'state.db');
      const transport = mesh.createMeshTransport({ dbPath });
      transport.close();
      let woke = false;
      const observer = mesh.createMeshTransport({ dbPath });
      try {
        // A generous deadline, not a tight window: on macOS a just-created
        // FSEvents stream takes a beat before it starts reporting, and 300ms
        // flaked on a busy runner (main run for 5dc0c116). The assertion
        // still requires the wake to arrive.
        const wait = observer.waitForChange(5000).then(reason => { woke = reason === 'change'; });
        fs.appendFileSync(`${dbPath}-wal`, 'append');
        await wait;
        assert.strictEqual(woke, true, 'a live transport still wakes (sanity)');
        assert.strictEqual(transport.pendingWaiters(), 0, 'closed transport holds no waiters');
      } finally {
        observer.close();
      }
    });
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[FAIL]', err);
  process.exit(1);
});
