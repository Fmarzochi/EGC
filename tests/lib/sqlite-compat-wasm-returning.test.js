/**
 * The portable engine (sql.js, scripts/lib/state-store/sqlite-compat-wasm.js)
 * keeps the database in memory and writes the file under the write lock
 * when a statement mutates. A statement that mutates and gives rows back
 * (DELETE or UPDATE with RETURNING) arrives through all(), the only method
 * that returns rows: this test proves it is written to the file like any
 * write, so a second opener of the same file does not see the deleted rows
 * again, and that a plain SELECT through all() still writes nothing.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openWasmDatabase } = require('../../scripts/lib/state-store/sqlite-compat-wasm');
const { mutates } = require('../../scripts/lib/state-store/sqlite-compat-sql');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

async function main() {
  console.log('\n=== Testing the portable engine with a statement that writes and returns rows ===\n');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-wasm-returning-'));
  const file = path.join(root, 'state.db');
  try {
    await test('a DELETE with RETURNING through all() returns the rows it removed and is written to the file', async () => {
      const db = await openWasmDatabase(file, null);
      await db.exec('CREATE TABLE machines (id INTEGER PRIMARY KEY, seen_at TEXT NOT NULL)');
      await db.run('INSERT INTO machines (id, seen_at) VALUES (1, ?), (2, ?), (3, ?)', '2026-11-27T19:00:00.000Z', '2026-11-27T19:30:00.000Z', '2026-11-27T20:00:00.000Z');
      const swept = await db.all('DELETE FROM machines WHERE seen_at < ? RETURNING id', '2026-11-27T19:45:00.000Z');
      assert.deepStrictEqual(swept.map(row => row.id).sort(), [1, 2], 'the rows removed come back');
      await db.close();

      const again = await openWasmDatabase(file, null);
      const left = await again.all('SELECT id FROM machines ORDER BY id');
      assert.deepStrictEqual(left.map(row => row.id), [3], 'the removal reached the file: a fresh opener sees only what stayed');
      await again.close();
    });

    await test('a SELECT and a reporting pragma through all() write nothing to the file', async () => {
      const before = fs.statSync(file).mtimeMs;
      const db = await openWasmDatabase(file, null);
      const rows = await db.all('SELECT id FROM machines');
      assert.strictEqual(rows.length, 1);
      const columns = await db.all('PRAGMA table_info(machines)');
      assert.deepStrictEqual(columns.map(column => column.name), ['id', 'seen_at']);
      await db.close();
      assert.strictEqual(fs.statSync(file).mtimeMs, before, 'a read leaves the file as it was');
      for (const read of ['PRAGMA table_info(machines)', 'PRAGMA table_xinfo(machines)', 'PRAGMA index_list(machines)', 'PRAGMA foreign_key_list(machines)', 'PRAGMA user_version']) {
        assert.strictEqual(mutates(read), false, `${read} is a read`);
      }
      for (const write of ['PRAGMA user_version = 3', 'DELETE FROM machines WHERE id = 3 RETURNING id', 'UPDATE machines SET seen_at = seen_at']) {
        assert.strictEqual(mutates(write), true, `${write} is a write`);
      }
    });

    await test('an UPDATE with RETURNING through all() is written too', async () => {
      const db = await openWasmDatabase(file, null);
      const touched = await db.all('UPDATE machines SET seen_at = ? WHERE id = 3 RETURNING id, seen_at', '2026-11-27T21:00:00.000Z');
      assert.deepStrictEqual(touched, [{ id: 3, seen_at: '2026-11-27T21:00:00.000Z' }]);
      await db.close();
      const again = await openWasmDatabase(file, null);
      const row = await again.get('SELECT seen_at FROM machines WHERE id = 3');
      assert.strictEqual(row.seen_at, '2026-11-27T21:00:00.000Z');
      await again.close();
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
