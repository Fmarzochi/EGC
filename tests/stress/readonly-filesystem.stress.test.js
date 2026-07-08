/**
 * STR-05: Read-only filesystem simulation.
 * Revoke write permission on temp directory (or file) after DB creation.
 * Assert store.upsertSession() throws a clear Error.
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
  await test('store.upsertSession() throws Error on read-only DB file', async () => {
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

    // Initial upsert should succeed
    store.upsertSession(validSession);
    
    // Make the file read-only to simulate read-only filesystem
    fs.chmodSync(dbPath, 0o444);
    
    const originalConsoleError = console.error;
    console.error = () => {}; // silence expected error logs
    try {
      store.upsertSession({ ...validSession, snapshot: { foo: 'baz' } });
      assert.fail('upsertSession should have thrown an Error');
    } catch (err) {
      assert.ok(err.code === 'EPERM' || err.code === 'EACCES' || err.message.includes('readonly'), `Expected EPERM or EACCES, got: ${err.code || err.message}`);
    } finally {
      console.error = originalConsoleError;
      // Restore permissions so we can clean up
      try { fs.chmodSync(dbPath, 0o666); } catch (_e) { /* ignore */ }
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    }
  });

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
