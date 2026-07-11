/**
 * STR-05: Read-only filesystem simulation.
 * Revoke write permission on the DB file after creation. Writes are
 * debounced (PERF-01), so upsertSession() itself no longer throws
 * synchronously — the failure is logged when the write is actually
 * flushed to disk. Assert store.flush() surfaces that failure.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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
  await test('store.flush() throws Error when the DB file is read-only', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-test-'));
    const dbPath = path.join(tempDir, 'state.db');

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
      assert.ok(fs.existsSync(dbPath), 'DB file must exist before the read-only simulation');

      // Make the file read-only to simulate a read-only filesystem
      fs.chmodSync(dbPath, 0o444);

      const originalConsoleError = console.error;
      let errorLogged = false;
      console.error = (msg, ..._rest) => {
        if (typeof msg === 'string' && msg.includes('Failed to persist state')) errorLogged = true;
      };
      try {
        store.upsertSession({ ...validSession, snapshot: { foo: 'baz' } });
        await assert.rejects(
          () => store.flush(),
          /EPERM|EACCES|EROFS/,
          'Expected a filesystem permission error'
        );
        assert.ok(errorLogged, 'Expected console.error to be called for the filesystem error');
      } finally {
        console.error = originalConsoleError;
      }
    } finally {
      // Restore permissions so we can close/clean up
      try { fs.chmodSync(dbPath, 0o666); } catch (_e) { /* ignore */ }
      try { store.close(); } catch (_e) { /* ignore */ }
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    }
  });

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
