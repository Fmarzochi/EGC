'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('../../mcp/servers/egc-memory/node_modules/sqlite3');
const { open } = require('../../mcp/servers/egc-memory/node_modules/sqlite');

const {
  createWorkingMemoryTable,
  sweepExpired,
  setWorkingMemory,
  getWorkingMemory,
  listWorkingMemory,
  SESSION_TTL_SECONDS,
} = require('../../mcp/servers/egc-memory/build/working-memory');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function openDb(dirPath) {
  const dbPath = path.join(dirPath, 'test.db');
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL;');
  await createWorkingMemoryTable(db);
  return db;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function runTests() {
  console.log('\n=== Testing working-memory.js ===\n');

  let passed = 0;
  let failed = 0;

  if (await test('SESSION_TTL_SECONDS is one day', () => {
    assert.strictEqual(SESSION_TTL_SECONDS, 86400);
  })) passed++; else failed++;

  if (await test('createWorkingMemoryTable is idempotent', async () => {
    const dir = makeTmpDir('egc-wm-idempotent-');
    const db = await openDb(dir);
    // Calling again must not throw
    await createWorkingMemoryTable(db);
    await db.close();
  })) passed++; else failed++;

  if (await test('set and get a fresh entry', async () => {
    const dir = makeTmpDir('egc-wm-set-get-');
    const db = await openDb(dir);

    await setWorkingMemory(db, '/proj/a', 'my_key', 'my_value');
    const entry = await getWorkingMemory(db, '/proj/a', 'my_key');

    assert.ok(entry, 'entry should exist');
    assert.strictEqual(entry.key, 'my_key');
    assert.strictEqual(entry.value, 'my_value');
    assert.ok(entry.expires_at > nowSeconds(), 'expires_at must be in the future');

    await db.close();
  })) passed++; else failed++;

  if (await test('set updates an existing key', async () => {
    const dir = makeTmpDir('egc-wm-update-');
    const db = await openDb(dir);

    await setWorkingMemory(db, '/proj/a', 'k', 'first');
    await setWorkingMemory(db, '/proj/a', 'k', 'second');
    const entry = await getWorkingMemory(db, '/proj/a', 'k');

    assert.strictEqual(entry.value, 'second');

    const rows = await db.all('SELECT * FROM working_memory WHERE project_path = ?', ['/proj/a']);
    assert.strictEqual(rows.length, 1, 'only one row should exist after upsert');

    await db.close();
  })) passed++; else failed++;

  if (await test('get returns null for missing key', async () => {
    const dir = makeTmpDir('egc-wm-missing-');
    const db = await openDb(dir);

    const entry = await getWorkingMemory(db, '/proj/a', 'no_such_key');
    assert.strictEqual(entry, null);

    await db.close();
  })) passed++; else failed++;

  if (await test('get returns null for expired entry', async () => {
    const dir = makeTmpDir('egc-wm-expired-get-');
    const db = await openDb(dir);

    // Insert a row that is already expired
    await db.run(
      `INSERT INTO working_memory (id, project_path, key, value, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['test-id', '/proj/a', 'stale_key', 'stale_value', nowSeconds() - 1]
    );

    const entry = await getWorkingMemory(db, '/proj/a', 'stale_key');
    assert.strictEqual(entry, null);

    await db.close();
  })) passed++; else failed++;

  if (await test('list returns only live entries ordered by key', async () => {
    const dir = makeTmpDir('egc-wm-list-');
    const db = await openDb(dir);

    await setWorkingMemory(db, '/proj/a', 'z_key', 'last');
    await setWorkingMemory(db, '/proj/a', 'a_key', 'first');

    // Insert an expired row that must not appear
    await db.run(
      `INSERT INTO working_memory (id, project_path, key, value, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['exp-id', '/proj/a', 'expired_key', 'gone', nowSeconds() - 1]
    );

    const entries = await listWorkingMemory(db, '/proj/a');
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].key, 'a_key');
    assert.strictEqual(entries[1].key, 'z_key');

    await db.close();
  })) passed++; else failed++;

  if (await test('list is scoped to project_path', async () => {
    const dir = makeTmpDir('egc-wm-scope-');
    const db = await openDb(dir);

    await setWorkingMemory(db, '/proj/a', 'shared_key', 'proj-a');
    await setWorkingMemory(db, '/proj/b', 'shared_key', 'proj-b');

    const forA = await listWorkingMemory(db, '/proj/a');
    const forB = await listWorkingMemory(db, '/proj/b');

    assert.strictEqual(forA.length, 1);
    assert.strictEqual(forA[0].value, 'proj-a');
    assert.strictEqual(forB.length, 1);
    assert.strictEqual(forB[0].value, 'proj-b');

    await db.close();
  })) passed++; else failed++;

  if (await test('sweepExpired removes expired rows and returns count', async () => {
    const dir = makeTmpDir('egc-wm-sweep-');
    const db = await openDb(dir);

    await db.run(
      `INSERT INTO working_memory (id, project_path, key, value, expires_at) VALUES
        ('id1', '/p', 'alive',   'v', ?),
        ('id2', '/p', 'dead1',   'v', ?),
        ('id3', '/p', 'dead2',   'v', ?)`,
      [nowSeconds() + 9999, nowSeconds() - 1, nowSeconds() - 100]
    );

    const swept = await sweepExpired(db);
    assert.strictEqual(swept, 2, 'should have removed 2 expired rows');

    const remaining = await db.all('SELECT key FROM working_memory');
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].key, 'alive');

    await db.close();
  })) passed++; else failed++;

  if (await test('sweepExpired returns 0 when nothing is expired', async () => {
    const dir = makeTmpDir('egc-wm-sweep-zero-');
    const db = await openDb(dir);

    await setWorkingMemory(db, '/proj/a', 'k', 'v', 9999);
    const swept = await sweepExpired(db);
    assert.strictEqual(swept, 0);

    await db.close();
  })) passed++; else failed++;

  if (await test('explicit ttl_seconds overrides the session default', async () => {
    const dir = makeTmpDir('egc-wm-ttl-');
    const db = await openDb(dir);

    const before = nowSeconds();
    await setWorkingMemory(db, '/proj/a', 'short', 'v', 60);
    const entry = await getWorkingMemory(db, '/proj/a', 'short');

    assert.ok(entry.expires_at >= before + 60, 'expires_at must reflect the requested TTL');
    assert.ok(entry.expires_at < before + 62, 'expires_at must not overshoot by more than 2s');

    await db.close();
  })) passed++; else failed++;

  if (await test('set stores JSON values correctly', async () => {
    const dir = makeTmpDir('egc-wm-json-');
    const db = await openDb(dir);

    const payload = JSON.stringify({ flag: true, count: 42, tags: ['a', 'b'] });
    await setWorkingMemory(db, '/proj/a', 'json_entry', payload);
    const entry = await getWorkingMemory(db, '/proj/a', 'json_entry');

    assert.strictEqual(entry.value, payload);
    const parsed = JSON.parse(entry.value);
    assert.strictEqual(parsed.flag, true);
    assert.strictEqual(parsed.count, 42);

    await db.close();
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
