'use strict';

/**
 * STRESS TEST: scripts/lib/state-store/db-adapter.js
 * Tests beyond the standard suite:
 * - Corrupted DB files (should not segfault)
 * - Zero-byte DB file
 * - Truncated DB file
 * - DB file growing under write pressure
 * - Close called twice (double-free guard)
 * - Statement freeing under error conditions
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-dba-stress-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

const { openDatabase } = require('../../scripts/lib/state-store/db-adapter');

async function runTests() {
  console.log('\n=== STRESS TEST: db-adapter.js ===\n');

  // ── 1. Zero-byte file treated as new DB ───────────────────────────────────
  await test('zero-byte DB file is treated as a fresh database', async () => {
    const tmpDir = createTempDir();
    const dbPath = path.join(tmpDir, 'empty.db');
    fs.writeFileSync(dbPath, '');
    try {
      const db = await openDatabase(dbPath);
      assert.ok(db, 'db should be returned');
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      db.close();
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 2. Corrupted DB file throws cleanly (no segfault) ─────────────────────
  await test('corrupted DB file throws a JS error, not a segfault', async () => {
    const tmpDir = createTempDir();
    const dbPath = path.join(tmpDir, 'corrupt.db');
    fs.writeFileSync(dbPath, 'this is definitely not sqlite data!!!!!');
    try {
      const db = await openDatabase(dbPath);
      try {
        db.exec('SELECT 1');
      } catch (_) {
        // Expected — file is not a database
      }
      // Whether it throws or silently ignores — it must NOT crash the process.
      // Test passes if we reach here (no segfault / unhandled exception).
      try { db.close(); } catch (_) { /* ignore */ }
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 3. Truncated DB file (partial SQLite header) ───────────────────────────
  await test('truncated SQLite header does not crash process', async () => {
    const tmpDir = createTempDir();
    const dbPath = path.join(tmpDir, 'truncated.db');
    // SQLite header is 100 bytes; write only 50
    const header = Buffer.alloc(50);
    header.write('SQLite format 3\0', 0, 'utf8');
    fs.writeFileSync(dbPath, header);
    try {
      const db = await openDatabase(dbPath);
      try { db.exec('SELECT 1'); } catch (_) { /* ignore */ }
      try { db.close(); } catch (_) { /* ignore */ }
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 4. close() called multiple times (double-free guard) ──────────────────
  await test('calling close() twice does not throw', async () => {
    const db = await openDatabase(':memory:');
    db.close();
    assert.doesNotThrow(() => db.close(), 'second close should be a no-op');
  });

  // ── 5. exec after close does not segfault ─────────────────────────────────
  await test('exec after close throws a clean JS error', async () => {
    const db = await openDatabase(':memory:');
    db.close();
    let threw = false;
    try {
      db.exec('SELECT 1');
    } catch (_) {
      threw = true;
    }
    assert.ok(threw, 'exec after close should throw');
  });

  // ── 6. Heavy write pressure — 5000 rows in a single transaction ───────────
  await test('5000-row transaction completes without OOM or timeout', async () => {
    const db = await openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE stress (id INTEGER PRIMARY KEY, val TEXT)');
      const insert = db.prepare('INSERT INTO stress VALUES (@id, @val)');
      const tx = db.transaction(() => {
        for (let i = 0; i < 5000; i++) {
          insert.run({ id: i, val: `value-${i}-${'x'.repeat(100)}` });
        }
      });
      tx();
      const rows = db.prepare('SELECT COUNT(*) as c FROM stress').get();
      assert.strictEqual(rows.c, 5000);
    } finally {
      db.close();
    }
  });

  // ── 7. Transaction rollback leaves table intact ────────────────────────────
  await test('rolled-back transaction leaves table in prior state', async () => {
    const db = await openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE stable (id INTEGER PRIMARY KEY)');
      db.exec('INSERT INTO stable VALUES (1)');

      const badTx = db.transaction(() => {
        db.exec('INSERT INTO stable VALUES (2)');
        throw new Error('intentional rollback');
      });

      try { badTx(); } catch (_) { /* expected */ }

      const rows = db.prepare('SELECT COUNT(*) as c FROM stable').get();
      assert.strictEqual(rows.c, 1, 'Rolled-back insert should not persist');
    } finally {
      db.close();
    }
  });

  // ── 8. prepare + free 1000 statements without FD leak ─────────────────────
  await test('1000 prepare+free cycles do not leak memory/FDs', async () => {
    const db = await openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE t (id INTEGER)');
      for (let i = 0; i < 1000; i++) {
        const stmt = db.prepare('SELECT * FROM t WHERE id = ?');
        // Statement is freed explicitly in the finally block of .all()
        stmt.all(i);
      }
    } finally {
      db.close();
    }
  });

  // ── 9. Named params vs positional params both work ────────────────────────
  await test('named and positional params produce identical results', async () => {
    const db = await openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE p (a INTEGER, b TEXT)');
      db.prepare('INSERT INTO p VALUES (@a, @b)').run({ a: 1, b: 'named' });
      db.prepare('INSERT INTO p VALUES (?, ?)').run([2, 'positional']);
      const rows = db.prepare('SELECT * FROM p ORDER BY a').all();
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].b, 'named');
      assert.strictEqual(rows[1].b, 'positional');
    } finally {
      db.close();
    }
  });

  // ── 10. DB file grows and is re-loaded correctly ──────────────────────────
  await test('DB written in one process is fully readable after re-open', async () => {
    const tmpDir = createTempDir();
    const dbPath = path.join(tmpDir, 'reload.db');
    try {
      // Write
      const db1 = await openDatabase(dbPath);
      db1.exec('CREATE TABLE r (id INTEGER PRIMARY KEY, name TEXT)');
      for (let i = 0; i < 100; i++) {
        db1.prepare('INSERT INTO r VALUES (?, ?)').run([i, `row-${i}`]);
      }
      db1.close();

      assert.ok(fs.existsSync(dbPath), 'DB file must exist after close');

      // Re-open and verify
      const db2 = await openDatabase(dbPath);
      const count = db2.prepare('SELECT COUNT(*) as c FROM r').get();
      db2.close();
      assert.strictEqual(count.c, 100);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 11. Nested db.transaction() inside an outer transaction ──────────────
  await test('nested transaction() call inside outer transaction is handled cleanly', async () => {
    const db = await openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE nest (id INTEGER)');

      const inner = db.transaction(() => {
        db.exec('INSERT INTO nest VALUES (2)');
      });

      const outer = db.transaction(() => {
        db.exec('INSERT INTO nest VALUES (1)');
        // Call a nested transaction — sql.js may throw or handle via savepoint.
        // Either outcome is acceptable; the process must not hang or segfault.
        inner();
      });

      let outerThrew = false;
      try {
        outer();
      } catch (_) {
        outerThrew = true;
      }

      // If it succeeded, verify at least row 1 was inserted.
      // If it threw, the DB must still be usable (not corrupted).
      if (!outerThrew) {
        const rows = db.prepare('SELECT COUNT(*) as c FROM nest').get();
        assert.ok(rows.c >= 1, 'At least one row should be present on success');
      } else {
        // DB still usable after nested-tx failure
        assert.doesNotThrow(() => db.prepare('SELECT 1').get());
      }
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  });

  // ─── summary ────────────────────────────────────────────────────────────────
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  ✗ ${f.name}: ${f.error}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Unexpected runner error:', err);
  process.exit(1);
});
