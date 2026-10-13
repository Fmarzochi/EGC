'use strict';

/**
 * Focused concurrency safety tests for SQLite file lock implementation.
 *
 * Scenarios tested:
 *   1. Active lock survives beyond 30s TTL when local process is alive.
 *   2. Remote-host lock cannot be revoked after 30s (fails closed).
 *   3. Stale lock recovery when owning PID is dead (crash recovery).
 *   4. Concurrent stale-lock recovery gives ownership to single winner without double unlink.
 *   5. Release with mismatched/unauthorized token does not delete, move, or rename active lock.
 *   6. Unauthorized release attempt does not create a vacancy or permit a competing writer to enter.
 *   7. Malformed lock payload (negative PID, string PID, corrupt JSON) does not cause unsafe reclamation.
 *   8. Lock acquisition timeout reports holder PID, hostname, and token.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  acquireFileLock,
  releaseFileLock,
  openCompatDatabase,
} = require('../../scripts/lib/state-store/sqlite-compat');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
  }
}

function makeTempLockPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-lock-test-'));
  const lockPath = path.join(dir, 'test.db.db-lock');
  return { dir, lockPath };
}

function cleanupTemp(dir, lockPath) {
  try { fs.unlinkSync(lockPath); } catch (_) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

async function runTests() {
  console.log('Testing SQLite file lock safety (TTL, ownership, recovery)...');

  await test('active lock survives beyond 30s TTL when owning process is alive', async () => {
    const { dir, lockPath } = makeTempLockPath();
    try {
      const payload = {
        token: 'active-owner-token',
        pid: process.pid,
        acquiredAt: Date.now() - 35000,
        hostname: os.hostname(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(payload));

      let errorThrown = null;
      try {
        await acquireFileLock(lockPath, { timeoutMs: 150, retryIntervalMs: 20 });
      } catch (err) {
        errorThrown = err;
      }

      assert.ok(
        errorThrown && /Lock timeout/i.test(errorThrown.message),
        `Expected Lock timeout error, got: ${errorThrown ? errorThrown.message : 'no error'}`
      );
      assert.ok(fs.existsSync(lockPath), 'Lock file should still exist');
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.strictEqual(current.token, 'active-owner-token');
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('remote-host lock cannot be revoked after 30s (fails closed)', async () => {
    const { dir, lockPath } = makeTempLockPath();
    try {
      const payload = {
        token: 'remote-worker-token',
        pid: 12345,
        acquiredAt: Date.now() - 60000,
        hostname: 'remote-server-node-99.internal',
      };
      fs.writeFileSync(lockPath, JSON.stringify(payload));

      let errorThrown = null;
      try {
        await acquireFileLock(lockPath, { timeoutMs: 150, retryIntervalMs: 20 });
      } catch (err) {
        errorThrown = err;
      }

      assert.ok(
        errorThrown && /Lock timeout/i.test(errorThrown.message),
        `Expected Lock timeout, got: ${errorThrown ? errorThrown.message : 'no error'}`
      );
      assert.ok(
        errorThrown && errorThrown.message.includes('remote-server-node-99.internal'),
        `Error message should mention remote hostname: ${errorThrown ? errorThrown.message : ''}`
      );
      assert.ok(fs.existsSync(lockPath), 'Remote lock file must not be removed');
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.strictEqual(current.token, 'remote-worker-token');
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('dead-PID lock fails closed with actionable manual recovery error', async () => {
    const { dir, lockPath } = makeTempLockPath();
    try {
      let deadPid = 999999;
      try {
        process.kill(deadPid, 0);
        deadPid = 999998;
      } catch (_) {
        // Expected ESRCH: deadPid is not running
      }

      const stalePayload = {
        token: 'crashed-process-token',
        pid: deadPid,
        acquiredAt: Date.now() - 10000,
        hostname: os.hostname(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(stalePayload));

      let errorThrown = null;
      try {
        await acquireFileLock(lockPath, { timeoutMs: 2000, retryIntervalMs: 20 });
      } catch (err) {
        errorThrown = err;
      }

      assert.ok(errorThrown, 'Expected error when acquiring lock held by dead local PID');
      assert.ok(
        errorThrown.message.includes(lockPath),
        `Error must contain lock file path: ${errorThrown.message}`
      );
      assert.ok(
        errorThrown.message.includes(String(deadPid)),
        `Error must contain dead PID: ${errorThrown.message}`
      );
      assert.ok(
        /manual|remove|rm/i.test(errorThrown.message),
        `Error must contain manual recovery instructions: ${errorThrown.message}`
      );
      assert.ok(
        fs.existsSync(lockPath),
        'Lock file must NOT be automatically deleted by acquireFileLock'
      );

      // Verify manual recovery: operator removes stale lock file
      fs.unlinkSync(lockPath);

      // Subsequent acquisition now succeeds cleanly
      const newToken = await acquireFileLock(lockPath, { timeoutMs: 2000, retryIntervalMs: 20 });
      assert.ok(newToken, 'Expected new token after manual lock file cleanup');
      assert.ok(fs.existsSync(lockPath));
      releaseFileLock(lockPath, newToken);
      assert.ok(!fs.existsSync(lockPath));
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('concurrent attempts to acquire dead-process lock fail closed without deleting lock', async () => {
    const { dir, lockPath } = makeTempLockPath();
    try {
      let deadPid = 999997;
      const stalePayload = {
        token: 'stale-race-token',
        pid: deadPid,
        acquiredAt: Date.now() - 60000,
        hostname: os.hostname(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(stalePayload));

      const p1 = acquireFileLock(lockPath, { timeoutMs: 3000, retryIntervalMs: 15 });
      const p2 = acquireFileLock(lockPath, { timeoutMs: 3000, retryIntervalMs: 15 });

      const results = await Promise.allSettled([p1, p2]);
      assert.strictEqual(results[0].status, 'rejected', 'First contender must fail closed');
      assert.strictEqual(results[1].status, 'rejected', 'Second contender must fail closed');
      assert.ok(
        results[0].reason.message.includes(String(deadPid)),
        'First contender error must mention dead PID'
      );
      assert.ok(
        results[1].reason.message.includes(String(deadPid)),
        'Second contender error must mention dead PID'
      );
      assert.ok(
        fs.existsSync(lockPath),
        'Lock file must remain intact and must NOT be deleted by concurrent contenders'
      );
      const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.strictEqual(onDisk.token, 'stale-race-token');
      assert.strictEqual(onDisk.pid, deadPid);
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('concurrent attempts from separate OS processes on dead-process lock fail closed', async () => {
    const { dir, lockPath } = makeTempLockPath();
    try {
      let deadPid = 999996;
      const stalePayload = {
        token: 'stale-proc-token',
        pid: deadPid,
        acquiredAt: Date.now() - 60000,
        hostname: os.hostname(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(stalePayload));

      const sqliteCompatPath = path.resolve(__dirname, '../../scripts/lib/state-store/sqlite-compat.js');
      const workerCode = `
        const { acquireFileLock } = require(${JSON.stringify(sqliteCompatPath)});
        acquireFileLock(${JSON.stringify(lockPath)}, { timeoutMs: 1000 })
          .then(() => process.exit(0))
          .catch(err => {
            if (err.message && err.message.includes(${JSON.stringify(String(deadPid))})) {
              process.exit(42);
            }
            process.exit(1);
          });
      `;

      const { spawn } = require('node:child_process');
      const runChild = () => new Promise(resolve => {
        const child = spawn(process.execPath, ['-e', workerCode], { stdio: 'pipe' });
        child.on('close', code => resolve(code));
      });

      const codes = await Promise.all([runChild(), runChild(), runChild()]);
      assert.deepStrictEqual(codes, [42, 42, 42], 'All separate OS processes must exit with code 42 (fail closed with dead PID error)');
      assert.ok(fs.existsSync(lockPath), 'Lock file must still exist untouched');
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('unauthorized release attempt does not remove, move, or rename active lock', async () => {
    const { dir, lockPath } = makeTempLockPath();
    try {
      const realToken = await acquireFileLock(lockPath, { timeoutMs: 2000 });
      assert.ok(realToken);

      // Attempt release with unauthorized token
      releaseFileLock(lockPath, 'fraudulent-token-12345');

      // Verify lock file exists uninterrupted with exact realToken
      assert.ok(fs.existsSync(lockPath), 'Lock file must still exist');
      const content = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.strictEqual(content.token, realToken, 'Lock token must remain unchanged');

      // Valid release
      releaseFileLock(lockPath, realToken);
      assert.ok(!fs.existsSync(lockPath), 'Lock file should now be removed');
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('unauthorized release does not open vacancy for competing writer', async () => {
    const { dir, lockPath } = makeTempLockPath();
    try {
      const realToken = await acquireFileLock(lockPath, { timeoutMs: 2000 });
      assert.ok(realToken);

      // Multiple unauthorized release attempts
      for (let i = 0; i < 5; i++) {
        releaseFileLock(lockPath, `unauthorized-${i}`);
      }

      // Competing acquire must still be blocked and time out
      let blockedError = null;
      try {
        await acquireFileLock(lockPath, { timeoutMs: 150, retryIntervalMs: 20 });
      } catch (err) {
        blockedError = err;
      }

      assert.ok(blockedError, 'Competing acquire should be blocked by active lock');
      assert.ok(/Lock timeout/i.test(blockedError.message));

      // Clean release
      releaseFileLock(lockPath, realToken);
      assert.ok(!fs.existsSync(lockPath));
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('malformed lock payloads do not cause unsafe reclamation', async () => {
    const { dir, lockPath } = makeTempLockPath();
    try {
      const invalidPayload = {
        token: 'invalid-token',
        pid: -1,
        acquiredAt: Date.now() - 40000,
        hostname: os.hostname(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(invalidPayload));

      let errorThrown = null;
      try {
        await acquireFileLock(lockPath, { timeoutMs: 150, retryIntervalMs: 20 });
      } catch (err) {
        errorThrown = err;
      }

      assert.ok(
        errorThrown && /Lock timeout/i.test(errorThrown.message),
        `Expected Lock timeout for invalid PID payload, got: ${errorThrown ? errorThrown.message : 'no error'}`
      );
      assert.ok(fs.existsSync(lockPath), 'Invalid payload lock file must not be unsafely removed');
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('lock acquisition timeout reports holder PID, hostname, and token', async () => {
    const { dir, lockPath } = makeTempLockPath();
    try {
      const token = await acquireFileLock(lockPath, { timeoutMs: 2000 });
      assert.ok(token);

      let caught = null;
      try {
        await acquireFileLock(lockPath, { timeoutMs: 100, retryIntervalMs: 20 });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught, 'Expected timeout error');
      assert.ok(
        caught.message.includes(`held by PID ${process.pid}`),
        `Error message should mention holder PID: ${caught.message}`
      );
      assert.ok(
        caught.message.includes(`token ${token}`),
        `Error message should mention holder token: ${caught.message}`
      );

      releaseFileLock(lockPath, token);
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('persistNow failure propagates to caller on mutation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-persist-fail-'));
    const dbFile = path.join(dir, 'test.db');
    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const db = await openCompatDatabase(dbFile);
      await db.run('CREATE TABLE items (id INT, val TEXT);');
      const origPersist = db.persistNow.bind(db);
      db.persistNow = () => {
        throw new Error('EACCES: permission denied, simulated write failure');
      };
      await assert.rejects(
        () => db.run('INSERT INTO items VALUES (1, "hello");'),
        /simulated write failure/
      );
      db.persistNow = origPersist;
      await db.close();
    } finally {
      delete process.env.EGC_SQLITE_ENGINE;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('lock and mutex cleanup when BEGIN setup throws', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-begin-fail-'));
    const dbFile = path.join(dir, 'test.db');
    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const db = await openCompatDatabase(dbFile);
      await db.run('CREATE TABLE items (val TEXT);');
      db.reloadFromDisk = () => {
        throw new Error('Disk reload corruption simulation');
      };
      await assert.rejects(
        () => db.exec('BEGIN;'),
        /Disk reload corruption simulation/
      );
      assert.strictEqual(db._inTransaction, false, 'Transaction flag must remain false');
      assert.strictEqual(db._txToken, null, 'Transaction lock token must be cleared');
      assert.ok(!fs.existsSync(db.getLockPath()), 'Lock file must be released on failure');

      delete db.reloadFromDisk;
      await db.run('INSERT INTO items VALUES ("after-fail");');
      const row = await db.get('SELECT val FROM items;');
      assert.strictEqual(row.val, 'after-fail');
      await db.close();
    } finally {
      delete process.env.EGC_SQLITE_ENGINE;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('no double mutex release on permission error during BEGIN', async () => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
      console.log('    - skipped: directory permission bits are not enforced here (root, or Windows)');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-eacces-'));
    const dbFile = path.join(dir, 'test.db');
    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const db = await openCompatDatabase(dbFile);
      await db.run('CREATE TABLE items (val TEXT);');

      // Make directory read-only so acquireFileLock immediately throws EACCES
      fs.chmodSync(dir, 0o555);

      await assert.rejects(
        () => db.exec('BEGIN;'),
        /EACCES/
      );
      assert.strictEqual(db._inTransaction, false, 'Transaction state must remain false');

      // Restore write permission so cleanup can run
      fs.chmodSync(dir, 0o755);

      // Verify mutex was released exactly once and is not corrupted:
      // a subsequent write succeeds cleanly without hanging or mutex error
      await db.run('INSERT INTO items VALUES ("clean-after-eacces");');
      const row = await db.get('SELECT val FROM items;');
      assert.strictEqual(row.val, 'clean-after-eacces');

      await db.close();
    } finally {
      delete process.env.EGC_SQLITE_ENGINE;
      try { fs.chmodSync(dir, 0o755); } catch (_) { /* ignore */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('closing during active transaction does not persist rolled-back state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-close-rb-'));
    const dbFile = path.join(dir, 'test.db');
    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const db1 = await openCompatDatabase(dbFile);
      await db1.run('CREATE TABLE items (val TEXT);');
      await db1.run('INSERT INTO items VALUES ("committed");');

      await db1.exec('BEGIN;');
      await db1.run('UPDATE items SET val = "uncommitted-dirty";');

      await db1.close();

      const db2 = await openCompatDatabase(dbFile);
      const row = await db2.get('SELECT val FROM items;');
      assert.strictEqual(row.val, 'committed', 'Uncommitted state must not have been persisted');
      await db2.close();
    } finally {
      delete process.env.EGC_SQLITE_ENGINE;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('lock cleanup cannot delete replacement owner lock', async () => {
    const { dir, lockPath } = makeTempLockPath();
    try {
      const payload1 = {
        token: 'token-1',
        pid: process.pid,
        acquiredAt: Date.now(),
        hostname: os.hostname(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(payload1));

      releaseFileLock(lockPath, 'token-2');
      assert.ok(fs.existsSync(lockPath), 'Lock must survive mismatched release');

      const payload3 = {
        token: 'token-3',
        pid: process.pid,
        acquiredAt: Date.now(),
        hostname: os.hostname(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(payload3));

      releaseFileLock(lockPath, 'token-1');
      assert.ok(fs.existsSync(lockPath), 'Replacement lock must survive former owner release');
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.strictEqual(current.token, 'token-3');

      releaseFileLock(lockPath, 'token-3');
      assert.ok(!fs.existsSync(lockPath));
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('mutual exclusion: second contender remains blocked while first holds lock', async () => {
    const { dir, lockPath } = makeTempLockPath();
    try {
      let c1Active = false;
      let c2Active = false;
      let maxConcurrent = 0;

      const runContender = async (id, holdTimeMs) => {
        const token = await acquireFileLock(lockPath, { timeoutMs: 3000, retryIntervalMs: 15 });
        if (id === 1) c1Active = true;
        if (id === 2) c2Active = true;

        const currentActive = (c1Active ? 1 : 0) + (c2Active ? 1 : 0);
        maxConcurrent = Math.max(maxConcurrent, currentActive);

        await new Promise(r => setTimeout(r, holdTimeMs));

        if (id === 1) c1Active = false;
        if (id === 2) c2Active = false;
        releaseFileLock(lockPath, token);
      };

      await Promise.all([
        runContender(1, 80),
        runContender(2, 80),
      ]);

      assert.strictEqual(maxConcurrent, 1, 'Only one contender may hold lock at any time');
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('strict mutual exclusion across separate OS processes under concurrent writers', async () => {
    const { dir, lockPath } = makeTempLockPath();
    const markerPath = path.join(dir, 'exclusive.marker');
    try {
      const sqliteCompatPath = path.resolve(__dirname, '../../scripts/lib/state-store/sqlite-compat.js');
      const workerCode = (id) => `
        const fs = require('node:fs');
        const { acquireFileLock, releaseFileLock } = require(${JSON.stringify(sqliteCompatPath)});
        async function run() {
          const token = await acquireFileLock(${JSON.stringify(lockPath)}, { timeoutMs: 10000, retryIntervalMs: 20 });
          // Check exclusivity: marker must not exist
          if (fs.existsSync(${JSON.stringify(markerPath)})) {
            console.error('Mutual exclusion violated! Marker already exists');
            process.exit(2);
          }
          fs.writeFileSync(${JSON.stringify(markerPath)}, 'worker-${id}');
          await new Promise(r => setTimeout(r, 40));
          const currentMarker = fs.readFileSync(${JSON.stringify(markerPath)}, 'utf8');
          if (currentMarker !== 'worker-${id}') {
            console.error('Marker was overwritten by another process');
            process.exit(3);
          }
          fs.unlinkSync(${JSON.stringify(markerPath)});
          releaseFileLock(${JSON.stringify(lockPath)}, token);
          process.exit(0);
        }
        run().catch(err => {
          console.error(err);
          process.exit(1);
        });
      `;

      const { spawn } = require('node:child_process');
      const runWorker = (id) => new Promise(resolve => {
        const child = spawn(process.execPath, ['-e', workerCode(id)], { stdio: 'pipe' });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', code => resolve({ id, code, stderr }));
      });

      const workers = await Promise.all([
        runWorker(1),
        runWorker(2),
        runWorker(3),
        runWorker(4),
      ]);

      for (const w of workers) {
        assert.strictEqual(w.code, 0, `Worker ${w.id} failed with exit code ${w.code}: ${w.stderr}`);
      }
      assert.ok(!fs.existsSync(markerPath));
      assert.ok(!fs.existsSync(lockPath));
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('COMMIT cleanly persists transaction and releases lock and mutex', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-commit-clean-'));
    const dbFile = path.join(dir, 'test.db');
    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const db = await openCompatDatabase(dbFile);
      await db.run('CREATE TABLE items (val TEXT);');
      await db.exec('BEGIN;');
      await db.run('INSERT INTO items VALUES ("tx-committed");');
      assert.strictEqual(db._inTransaction, true);
      assert.ok(fs.existsSync(db.getLockPath()));
      await db.exec('COMMIT;');
      assert.strictEqual(db._inTransaction, false);
      assert.strictEqual(db._txToken, null);
      assert.ok(!fs.existsSync(db.getLockPath()), 'Lock file must be released after COMMIT');

      const row = await db.get('SELECT val FROM items;');
      assert.strictEqual(row.val, 'tx-committed');
      await db.close();
    } finally {
      delete process.env.EGC_SQLITE_ENGINE;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('ROLLBACK cleanly discards transaction changes and releases lock and mutex', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-rollback-clean-'));
    const dbFile = path.join(dir, 'test.db');
    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const db = await openCompatDatabase(dbFile);
      await db.run('CREATE TABLE items (val TEXT);');
      await db.run('INSERT INTO items VALUES ("initial");');
      await db.exec('BEGIN;');
      await db.run('UPDATE items SET val = "modified-dirty";');
      assert.strictEqual(db._inTransaction, true);
      assert.ok(fs.existsSync(db.getLockPath()));
      await db.exec('ROLLBACK;');
      assert.strictEqual(db._inTransaction, false);
      assert.strictEqual(db._txToken, null);
      assert.ok(!fs.existsSync(db.getLockPath()), 'Lock file must be released after ROLLBACK');

      db.reloadFromDisk();
      const row = await db.get('SELECT val FROM items;');
      assert.strictEqual(row.val, 'initial');
      await db.close();
    } finally {
      delete process.env.EGC_SQLITE_ENGINE;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('closing a stale connection does not overwrite newer persisted data', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-stale-close-'));
    const dbFile = path.join(dir, 'test.db');
    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const db1 = await openCompatDatabase(dbFile, 'p1');
      await db1.run('CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT);');
      await db1.run('INSERT INTO items VALUES (?, ?);', ['key1', 'val1']);

      // A second connection opens, writes newer data, persists, and closes
      const db2 = await openCompatDatabase(dbFile, 'p2');
      await db2.run('INSERT INTO items VALUES (?, ?);', ['key2', 'val2']);
      await db2.close();

      // Verify on disk both key1 and key2 exist
      const checkDb = await openCompatDatabase(dbFile, 'check');
      const rowsBefore = await checkDb.all('SELECT id FROM items ORDER BY id;');
      assert.deepStrictEqual(rowsBefore.map(r => r.id), ['key1', 'key2']);
      await checkDb.close();

      // The first connection (whose in-memory snapshot lacks key2) closes
      await db1.close();

      // Verify on disk key2 was NOT clobbered by db1 closing
      const verifyDb = await openCompatDatabase(dbFile, 'verify');
      const rowsAfter = await verifyDb.all('SELECT id FROM items ORDER BY id;');
      assert.deepStrictEqual(
        rowsAfter.map(r => r.id),
        ['key1', 'key2'],
        'Closing db1 must not overwrite key2 persisted by db2'
      );
      await verifyDb.close();
    } finally {
      delete process.env.EGC_SQLITE_ENGINE;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('tryAcquireLockOnce write failure unlinks empty lock without deleting another lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-write-fail-'));
    const lockPath = path.join(dir, 'test.lock');
    try {
      // Simulate fs.writeFileSync failure during tryAcquireLockOnce
      const originalWriteFileSync = fs.writeFileSync;
      let injected = false;
      fs.writeFileSync = (targetFd, data, options) => {
        if (typeof targetFd === 'number' && !injected) {
          injected = true;
          throw new Error('ENOSPC: no space left on device simulation');
        }
        return originalWriteFileSync(targetFd, data, options);
      };

      try {
        await assert.rejects(
          async () => {
            await acquireFileLock(lockPath, { timeoutMs: 200, retryIntervalMs: 25 });
          },
          /ENOSPC/
        );
      } finally {
        fs.writeFileSync = originalWriteFileSync;
      }

      // Lock file must not remain as an empty/corrupted file
      assert.ok(!fs.existsSync(lockPath), 'Failed lock creation must clean up empty lock file');

      // Subsequent acquisition must succeed cleanly
      const token = await acquireFileLock(lockPath, { timeoutMs: 1000 });
      assert.ok(token);
      assert.ok(fs.existsSync(lockPath));
      releaseFileLock(lockPath, token);
      assert.ok(!fs.existsSync(lockPath));
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  const isWindows = process.platform === 'win32';

  function spawnChildWithTimeout(childCode, expectedText = 'LOCKED', timeoutMs = 8000) {
    const child = spawn(process.execPath, ['-e', childCode], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let timer = null;

    child.stdout.on('data', chunk => { stdoutBuffer += chunk.toString(); });
    child.stderr.on('data', chunk => { stderrBuffer += chunk.toString(); });

    const readyPromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore kill error */ }
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for child to emit "${expectedText}". stderr: ${stderrBuffer}`));
      }, timeoutMs);

      const checkMatch = () => {
        if (stdoutBuffer.includes(expectedText)) {
          clearTimeout(timer);
          resolve();
        }
      };

      child.stdout.on('data', checkMatch);
      child.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code, sig) => {
        clearTimeout(timer);
        if (!stdoutBuffer.includes(expectedText)) {
          reject(new Error(`Child exited prematurely with code ${code}, signal ${sig} before emitting "${expectedText}". stderr: ${stderrBuffer}`));
        }
      });
    });

    const waitExit = (exitTimeoutMs = 8000) => new Promise((resolve, reject) => {
      const exitTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore kill error */ }
        reject(new Error(`Child did not terminate within ${exitTimeoutMs}ms after signal`));
      }, exitTimeoutMs);

      child.on('exit', (code, sig) => {
        clearTimeout(exitTimer);
        resolve([code, sig]);
      });
    });

    return { child, readyPromise, waitExit, getStdout: () => stdoutBuffer, getStderr: () => stderrBuffer };
  }

  await test('signal handler cleans up held lock on SIGTERM and exits with signal code', async () => {
    if (isWindows) {
      console.log('    - skipped: POSIX signal semantics not supported on Windows');
      return;
    }
    const { dir, lockPath } = makeTempLockPath();
    try {
      const childCode = `
        const { acquireFileLock } = require(${JSON.stringify(path.resolve(__dirname, '../../scripts/lib/state-store/sqlite-compat'))});
        async function run() {
          await acquireFileLock(${JSON.stringify(lockPath)});
          process.stdout.write('LOCKED\\n');
          setInterval(() => {}, 1000);
        }
        run();
      `;
      const { child, readyPromise, waitExit } = spawnChildWithTimeout(childCode);
      try {
        await readyPromise;
        assert.ok(fs.existsSync(lockPath), 'Lock file should exist while child is alive');

        child.kill('SIGTERM');
        const [, signal] = await waitExit();

        assert.strictEqual(signal, 'SIGTERM', 'Child should terminate with SIGTERM');
        assert.ok(!fs.existsSync(lockPath), 'SIGTERM handler must remove lock file held by terminating child');
      } finally {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('signal handler cleans up held lock on SIGINT and exits with signal code', async () => {
    if (isWindows) {
      console.log('    - skipped: POSIX signal semantics not supported on Windows');
      return;
    }
    const { dir, lockPath } = makeTempLockPath();
    try {
      const childCode = `
        const { acquireFileLock } = require(${JSON.stringify(path.resolve(__dirname, '../../scripts/lib/state-store/sqlite-compat'))});
        async function run() {
          await acquireFileLock(${JSON.stringify(lockPath)});
          process.stdout.write('LOCKED\\n');
          setInterval(() => {}, 1000);
        }
        run();
      `;
      const { child, readyPromise, waitExit } = spawnChildWithTimeout(childCode);
      try {
        await readyPromise;
        assert.ok(fs.existsSync(lockPath), 'Lock file should exist while child is alive');

        child.kill('SIGINT');
        const [, signal] = await waitExit();

        assert.strictEqual(signal, 'SIGINT', 'Child should terminate with SIGINT');
        assert.ok(!fs.existsSync(lockPath), 'SIGINT handler must remove lock file held by terminating child');
      } finally {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('signal handler does not delete lock if reacquired by another process with different token', async () => {
    if (isWindows) {
      console.log('    - skipped: POSIX signal semantics not supported on Windows');
      return;
    }
    const { dir, lockPath } = makeTempLockPath();
    try {
      const childCode = `
        const { acquireFileLock } = require(${JSON.stringify(path.resolve(__dirname, '../../scripts/lib/state-store/sqlite-compat'))});
        const fs = require('fs');
        async function run() {
          await acquireFileLock(${JSON.stringify(lockPath)});
          process.stdout.write('LOCKED\\n');
          setInterval(() => {}, 1000);
          process.stdin.on('data', () => {
            fs.writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({
              token: 'other-token-uuid-1234',
              pid: 999999,
              acquiredAt: Date.now(),
              hostname: 'other-host'
            }));
            process.stdout.write('REPLACED\\n');
          });
        }
        run();
      `;
      const { child, readyPromise, waitExit, getStdout } = spawnChildWithTimeout(childCode);
      try {
        await readyPromise;

        const replacedPromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timed out waiting for REPLACED')), 5000);
          const check = () => {
            if (getStdout().includes('REPLACED')) {
              clearTimeout(timeout);
              resolve();
            }
          };
          child.stdout.on('data', check);
        });

        child.stdin.write('replace\n');
        await replacedPromise;

        child.kill('SIGTERM');
        await waitExit();

        assert.ok(fs.existsSync(lockPath), 'Lock must NOT be unlinked if token does not match held token');
        const content = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.strictEqual(content.token, 'other-token-uuid-1234');
      } finally {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('signal handler preserves unrelated application signal listeners', async () => {
    if (isWindows) {
      console.log('    - skipped: POSIX signal semantics not supported on Windows');
      return;
    }
    const { dir, lockPath } = makeTempLockPath();
    try {
      const childCode = `
        let appHandlerFired = false;
        process.on('SIGTERM', () => {
          appHandlerFired = true;
          process.stdout.write('APP_HANDLER_FIRED\\n');
          process.exit(42);
        });

        const { acquireFileLock } = require(${JSON.stringify(path.resolve(__dirname, '../../scripts/lib/state-store/sqlite-compat'))});
        async function run() {
          await acquireFileLock(${JSON.stringify(lockPath)});
          process.stdout.write('LOCKED\\n');
          setInterval(() => {}, 1000);
        }
        run();
      `;
      const { child, readyPromise, waitExit, getStdout } = spawnChildWithTimeout(childCode);
      try {
        await readyPromise;
        assert.ok(fs.existsSync(lockPath), 'Lock file should exist while child is alive');

        child.kill('SIGTERM');
        const [exitCode] = await waitExit();

        assert.strictEqual(exitCode, 42, 'Application SIGTERM listener should execute and dictate exit status');
        assert.ok(getStdout().includes('APP_HANDLER_FIRED'), 'Unrelated application listener output must be present');
        assert.ok(!fs.existsSync(lockPath), 'Held lock must be cleaned up on process exit even when custom listener catches signal');
      } finally {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('competing writer cannot acquire lock while writer remains alive after SIGTERM', async () => {
    if (isWindows) {
      console.log('    - skipped: POSIX signal semantics not supported on Windows');
      return;
    }
    const { dir, lockPath } = makeTempLockPath();
    try {
      // Writer ignores SIGTERM and remains active with its lock held
      const childCode = `
        process.on('SIGTERM', () => {
          process.stdout.write('SIGTERM_CAUGHT_STAYING_ALIVE\\n');
        });

        const { acquireFileLock } = require(${JSON.stringify(path.resolve(__dirname, '../../scripts/lib/state-store/sqlite-compat'))});
        async function run() {
          await acquireFileLock(${JSON.stringify(lockPath)});
          process.stdout.write('LOCKED\\n');
          setInterval(() => {}, 1000);
        }
        run();
      `;
      const { child, readyPromise, getStdout } = spawnChildWithTimeout(childCode);
      try {
        await readyPromise;
        assert.ok(fs.existsSync(lockPath), 'Lock file must exist while child is holding it');

        const caughtPromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timed out waiting for SIGTERM_CAUGHT')), 5000);
          const check = () => {
            if (getStdout().includes('SIGTERM_CAUGHT_STAYING_ALIVE')) {
              clearTimeout(timeout);
              resolve();
            }
          };
          child.stdout.on('data', check);
        });

        child.kill('SIGTERM');
        await caughtPromise;

        // The process stayed alive: lock must still exist and competing acquisition must timeout
        assert.ok(fs.existsSync(lockPath), 'Lock file must NOT be released while process remains alive');

        let competingThrew = false;
        try {
          await acquireFileLock(lockPath, { timeoutMs: 200, retryIntervalMs: 25 });
        } catch (err) {
          competingThrew = /Lock timeout/i.test(err.message);
        }
        assert.ok(competingThrew, 'Competing writer must be blocked while original writer stays alive');
      } finally {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('application listener receives exactly one invocation per SIGTERM and repeated signals remain safe', async () => {
    if (isWindows) {
      console.log('    - skipped: POSIX signal semantics not supported on Windows');
      return;
    }
    const { dir, lockPath } = makeTempLockPath();
    try {
      const childCode = `
        let invocationCount = 0;
        process.on('SIGTERM', () => {
          invocationCount++;
          process.stdout.write('INVOCATION:' + invocationCount + '\\n');
        });

        const { acquireFileLock } = require(${JSON.stringify(path.resolve(__dirname, '../../scripts/lib/state-store/sqlite-compat'))});
        async function run() {
          await acquireFileLock(${JSON.stringify(lockPath)});
          process.stdout.write('LOCKED\\n');
          setInterval(() => {}, 1000);
        }
        run();
      `;
      const { child, readyPromise, getStdout } = spawnChildWithTimeout(childCode);
      try {
        await readyPromise;

        const waitForInvocation = (count) => new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timed out waiting for INVOCATION:' + count)), 5000);
          const check = () => {
            if (getStdout().includes('INVOCATION:' + count)) {
              clearTimeout(timeout);
              resolve();
            }
          };
          child.stdout.on('data', check);
        });

        // First SIGTERM
        child.kill('SIGTERM');
        await waitForInvocation(1);
        await new Promise(r => setTimeout(r, 100));
        assert.ok(!getStdout().includes('INVOCATION:2'), 'External listener must be invoked only once for the first SIGTERM');

        // Repeated signal: Second SIGTERM
        child.kill('SIGTERM');
        await waitForInvocation(2);
        await new Promise(r => setTimeout(r, 100));
        assert.ok(!getStdout().includes('INVOCATION:3'), 'External listener must be invoked only once for the second SIGTERM');

        // Process is still alive: lock must still be held and valid
        assert.ok(fs.existsSync(lockPath), 'Lock must remain held across repeated handled signals');
      } finally {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }
    } finally {
      cleanupTemp(dir, lockPath);
    }
  });

  await test('new locks acquired after a handled signal are still protected on exit', async () => {
    if (isWindows) {
      console.log('    - skipped: POSIX signal semantics not supported on Windows');
      return;
    }
    const { dir, lockPath } = makeTempLockPath();
    const lockPath2 = lockPath + '-second';
    try {
      const childCode = `
        const fs = require('fs');
        const { acquireFileLock, releaseFileLock } = require(${JSON.stringify(path.resolve(__dirname, '../../scripts/lib/state-store/sqlite-compat'))});

        let lock1Token = null;
        let lock2Token = null;

        process.on('SIGTERM', async () => {
          process.stdout.write('SIGTERM_HANDLED\\n');
          // Release first lock, acquire second lock
          releaseFileLock(${JSON.stringify(lockPath)}, lock1Token);
          lock2Token = await acquireFileLock(${JSON.stringify(lockPath2)});
          process.stdout.write('ACQUIRED_SECOND\\n');
          // Terminate gracefully
          process.exit(0);
        });

        async function run() {
          lock1Token = await acquireFileLock(${JSON.stringify(lockPath)});
          process.stdout.write('LOCKED_FIRST\\n');
          setInterval(() => {}, 1000);
        }
        run();
      `;
      const { child, readyPromise, waitExit, getStdout } = spawnChildWithTimeout(childCode, 'LOCKED_FIRST');
      try {
        await readyPromise;
        assert.ok(fs.existsSync(lockPath), 'First lock must exist');

        const secondAcquiredPromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timed out waiting for ACQUIRED_SECOND')), 5000);
          const check = () => {
            if (getStdout().includes('ACQUIRED_SECOND')) {
              clearTimeout(timeout);
              resolve();
            }
          };
          child.stdout.on('data', check);
        });

        child.kill('SIGTERM');
        await secondAcquiredPromise;
        const [exitCode] = await waitExit();

        assert.strictEqual(exitCode, 0, 'Child should exit 0');
        assert.ok(!fs.existsSync(lockPath), 'First lock must be released');
        assert.ok(!fs.existsSync(lockPath2), 'Second lock acquired after handled signal must be cleaned up on process exit');
      } finally {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }
    } finally {
      cleanupTemp(dir, lockPath);
      cleanupTemp(dir, lockPath2);
    }
  });

  await test('detects atomic file replacement that keeps identical mtime via inode tracking', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-atomic-mtime-'));
    const dbFile = path.join(dir, 'test.db');
    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const db1 = await openCompatDatabase(dbFile);
      await db1.run('CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT);');
      await db1.run('INSERT INTO items VALUES ("k1", "v1");');

      // Verify db1 reads baseline
      const initialRow = await db1.get('SELECT val FROM items WHERE id = "k1";');
      assert.strictEqual(initialRow.val, 'v1');

      // Now create an updated database file externally and replace dbFile with identical mtime
      const statBefore = fs.statSync(dbFile);
      const db2 = await openCompatDatabase(path.join(dir, 'temp_replace.db'));
      await db2.run('CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT);');
      await db2.run('INSERT INTO items VALUES ("k1", "v2_updated");');
      await db2.close();

      // Force temp_replace.db to have the exact same mtime as dbFile
      fs.utimesSync(path.join(dir, 'temp_replace.db'), statBefore.atimeMs / 1000, statBefore.mtimeMs / 1000);
      fs.renameSync(path.join(dir, 'temp_replace.db'), dbFile);

      const statAfter = fs.statSync(dbFile);
      assert.strictEqual(statBefore.mtimeMs, statAfter.mtimeMs, 'Precondition: mtimeMs must be identical');
      assert.notStrictEqual(statBefore.ino, statAfter.ino, 'Precondition: inode must be different due to atomic replacement');

      // Reading via db1.get() / all() must detect inode change and reload updated data
      const updatedRow = await db1.get('SELECT val FROM items WHERE id = "k1";');
      assert.strictEqual(updatedRow.val, 'v2_updated', 'Reader must detect replacement with same mtime via inode change and reload');

      await db1.close();
    } finally {
      delete process.env.EGC_SQLITE_ENGINE;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests();
