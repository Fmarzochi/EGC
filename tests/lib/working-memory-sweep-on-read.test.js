'use strict';

/**
 * A working memory read sweeps every expired row instead of only hiding the
 * one it looked up, so a session that never calls get_state keeps the table clean.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '../../mcp/servers/egc-memory');
const MODULE_PATH = path.join(SERVER_ROOT, 'build', 'working-memory.js');
const SQLITE3_PATH = path.join(SERVER_ROOT, 'node_modules', 'sqlite3');
const SQLITE_PATH = path.join(SERVER_ROOT, 'node_modules', 'sqlite');

if (![MODULE_PATH, SQLITE3_PATH, SQLITE_PATH].every((candidate) => fs.existsSync(candidate))) {
  console.log(`[SKIP] Missing ${MODULE_PATH} or server dependencies. Run 'npm ci && npm run build' in mcp/servers/egc-memory first.`);
  process.exit(0);
}

const { createWorkingMemoryTable, getWorkingMemory, listWorkingMemory } = require(MODULE_PATH);
const { open } = require(SQLITE_PATH);
const sqlite3 = require(SQLITE3_PATH);

const EXPIRED = Math.floor(Date.now() / 1000) - 1;
const LIVE = Math.floor(Date.now() / 1000) + 9999;

function insertRow(db, id, project, key, expiresAt) {
  return db.run(
    'INSERT INTO working_memory (id, project_path, key, value, expires_at) VALUES (?, ?, ?, ?, ?)',
    [id, project, key, 'v', expiresAt]
  );
}

async function storedKeys(db) {
  const rows = await db.all('SELECT key FROM working_memory ORDER BY key');
  return rows.map((row) => row.key);
}

async function main() {
  console.log('\n=== Testing working memory sweep on read ===\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-wm-sweep-on-read-'));
  const db = await open({ filename: path.join(dir, 'test.db'), driver: sqlite3.Database });
  await createWorkingMemoryTable(db);

  let passed = 0;
  let failed = 0;
  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (error) {
      console.log(`  ✗ ${name}\n    Error: ${error.message}`);
      failed++;
    }
  };

  try {
    await test('the table carries an index on expires_at for the sweep', async () => {
      const indexes = (await db.all('PRAGMA index_list(working_memory)')).map((row) => row.name);
      assert.ok(indexes.includes('idx_working_memory_expires_at'), `indexes: ${indexes.join(', ')}`);
    });

    await test('get deletes every expired row instead of only hiding the one it looked up', async () => {
      await insertRow(db, 'live', '/proj/a', 'live_key', LIVE);
      await insertRow(db, 'stale-a', '/proj/a', 'stale_get', EXPIRED);
      await insertRow(db, 'stale-b', '/proj/b', 'stale_other', EXPIRED);

      assert.strictEqual(await getWorkingMemory(db, '/proj/a', 'stale_get'), null);
      assert.deepStrictEqual(await storedKeys(db), ['live_key']);
    });

    await test('list deletes the expired rows it leaves out', async () => {
      await insertRow(db, 'stale-c', '/proj/b', 'stale_list', EXPIRED);

      assert.deepStrictEqual(await listWorkingMemory(db, '/proj/b'), []);
      assert.deepStrictEqual(await storedKeys(db), ['live_key']);
    });
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
