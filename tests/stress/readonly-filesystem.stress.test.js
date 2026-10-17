/**
 * STR-05: Read-only filesystem simulation.
 * Revoke write permission on the directory of the DB file after creation.
 * Every write takes the <db>.db-lock file in that directory first, so the
 * permission error surfaces at the write itself, before anything reaches
 * the database file, and the file keeps what it had. Skipped where directory
 * permission bits are not enforced for the current user (Windows, root).
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { permissionBitsEnforced, withDirMode } = require('../fixtures/dir-permissions');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.error(`    Error: ${err.stack}`);
    failed++;
  }
}

(async () => {
  if (!permissionBitsEnforced()) {
    console.log('  - store.flush() throws Error when the DB directory is read-only (skipped: permission bits are not enforced here)');
    return;
  }

  await test('a write fails with the permission error when the DB directory is read-only, and the file keeps what it had', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-test-'));
    const dbDir = path.join(tempDir, 'store');
    const dbPath = path.join(dbDir, 'state.db');

    const { createStateStore } = require('../../scripts/lib/state-store/index.js');

    const store = await createStateStore({ dbPath });

    const validSession = {
      id: 'session-1',
      adapterId: 'stress-test',
      harness: 'cli',
      state: 'active',
      repoRoot: null,
      startedAt: null,
      endedAt: null,
      snapshot: { foo: 'bar' }
    };

    try {
      // Initial upsert (and the migrations before it) already flushed the
      // file to disk synchronously, so it exists at this point.
      store.upsertSession(validSession);
      await store.flush();
      assert.ok(fs.existsSync(dbPath), 'DB file must exist before the read-only simulation');

      // A read-only directory simulates a read-only filesystem
      await withDirMode(dbDir, 0o555, async () => {
        assert.throws(
          () => store.upsertSession({ ...validSession, snapshot: { foo: 'baz' } }),
          /EPERM|EACCES|EROFS/,
          'Expected a filesystem permission error at the write'
        );
        await store.flush();
        assert.ok(!fs.existsSync(`${dbPath}.db-lock`), 'no lock may be left behind by the refused write');
      });

      const again = await createStateStore({ dbPath });
      try {
        assert.deepStrictEqual(again.getSessionById('session-1').snapshot, { foo: 'bar' }, 'the file must keep the row as it was before the refused write');
      } finally {
        again.close();
      }
    } finally {
      try { store.close(); } catch (_e) { /* ignore */ }
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    }
  });

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
