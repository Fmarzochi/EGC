'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openCompatDatabase, isNativeLoadFailure, normalizeParams } = require('../../scripts/lib/state-store/sqlite-compat');

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
  console.log('\n=== Testing sqlite-compat (shared engine chooser) ===\n');
  let passed = 0;
  let failed = 0;
  const previous = process.env.EGC_SQLITE_ENGINE;

  if (await test('classifies native load failures and nothing else', async () => {
    assert.ok(isNativeLoadFailure(Object.assign(new Error('x'), { code: 'ERR_DLOPEN_FAILED' })));
    assert.ok(isNativeLoadFailure(new Error("/lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found (required by node_sqlite3.node)")));
    assert.ok(isNativeLoadFailure(new Error('Could not locate the bindings file. Tried:')));
    assert.ok(!isNativeLoadFailure(new Error('SQLITE_BUSY: database is locked')));
    assert.ok(!isNativeLoadFailure(null));
  })) passed++; else failed++;

  if (await test('normalizes the three parameter styles the sqlite package accepts', async () => {
    assert.deepStrictEqual(normalizeParams([]), undefined);
    assert.deepStrictEqual(normalizeParams([['a', undefined]]), ['a', null]);
    assert.deepStrictEqual(normalizeParams(['a', 2]), ['a', 2]);
    assert.deepStrictEqual(normalizeParams([{ id: 1, $name: 'n', ':x': undefined }]), { $id: 1, $name: 'n', ':x': null });
    assert.deepStrictEqual(normalizeParams([7]), [7]);
  })) passed++; else failed++;

  if (await test('the portable engine answers run, get, all and exec and persists to the file', async () => {
    process.env.EGC_SQLITE_ENGINE = 'wasm';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compat-'));
    const file = path.join(dir, 'nested', 'state.db');
    try {
      const db = await openCompatDatabase(file, 'test');
      await db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
      const first = await db.run('INSERT INTO items (name) VALUES (?)', ['alpha']);
      assert.strictEqual(first.lastID, 1);
      assert.strictEqual(first.changes, 1);
      await db.run('INSERT INTO items (name) VALUES ($name)', { name: 'beta' });
      const row = await db.get('SELECT name FROM items WHERE id = ?', 2);
      assert.strictEqual(row.name, 'beta');
      const rows = await db.all('SELECT name FROM items ORDER BY id');
      assert.deepStrictEqual(rows.map(r => r.name), ['alpha', 'beta']);
      await db.close();
      assert.ok(fs.existsSync(file), 'the database file must be written');
      const again = await openCompatDatabase(file, 'test');
      const back = await again.all('SELECT name FROM items ORDER BY id');
      assert.deepStrictEqual(back.map(r => r.name), ['alpha', 'beta']);
      await again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await test('exec keeps trigger bodies intact and stops at the first failing statement', async () => {
    process.env.EGC_SQLITE_ENGINE = 'wasm';
    const db = await openCompatDatabase(':memory:', 'test');
    await db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
      CREATE TABLE audit (item_id INTEGER, note TEXT);
      CREATE TRIGGER IF NOT EXISTS items_after_insert AFTER INSERT ON items BEGIN
        INSERT INTO audit(item_id, note) VALUES (new.id, 'inserted');
      END;
    `);
    await db.run('INSERT INTO items (name) VALUES (?)', ['alpha']);
    const audit = await db.all('SELECT note FROM audit');
    assert.deepStrictEqual(audit.map(r => r.note), ['inserted']);
    let failed = false;
    try {
      await db.exec('CREATE VIRTUAL TABLE nope USING fts5(x); CREATE TABLE never_created (id INTEGER);');
    } catch {
      failed = true;
    }
    assert.ok(failed, 'a statement the engine cannot run must throw');
    const tables = await db.all("SELECT name FROM sqlite_master WHERE name = 'never_created'");
    assert.strictEqual(tables.length, 0, 'statements after the failing one must not run');
    await db.close();
  })) passed++; else failed++;

  if (await test('writes that follow a pragma or start with a CTE are persisted', async () => {
    process.env.EGC_SQLITE_ENGINE = 'wasm';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compat-'));
    const file = path.join(dir, 'state.db');
    try {
      const db = await openCompatDatabase(file, 'test');
      await db.exec('PRAGMA foreign_keys = ON; CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
      await db.exec("PRAGMA foreign_keys = ON; INSERT INTO items (name) VALUES ('after-pragma')");
      await db.run("WITH seed(name) AS (SELECT 'from-cte') INSERT INTO items (name) SELECT name FROM seed");
      await db.close();
      const again = await openCompatDatabase(file, 'test');
      const rows = await again.all('SELECT name FROM items ORDER BY id');
      assert.deepStrictEqual(rows.map(r => r.name), ['after-pragma', 'from-cte']);
      await again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await test('ANALYZE and value-setting pragmas are persisted; SELECT and reporting pragmas are not treated as writes', async () => {
    process.env.EGC_SQLITE_ENGINE = 'wasm';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compat-'));
    const file = path.join(dir, 'state.db');
    try {
      const db = await openCompatDatabase(file, 'test');
      await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
      await db.close();
      const again = await openCompatDatabase(file, 'test');
      await again.exec('PRAGMA user_version = 7');
      await again.exec('ANALYZE');
      await again.close();
      const third = await openCompatDatabase(file, 'test');
      const version = await third.get('PRAGMA user_version');
      assert.strictEqual(Number(Object.values(version)[0]), 7, 'a value-setting pragma must reach the file');
      const stat = await third.all("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'");
      assert.strictEqual(stat.length, 1, 'ANALYZE output must reach the file');
      await third.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await test('a permission error on the write-ahead log is surfaced, not mistaken for an absent log', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      console.log('    - skipped: root ignores directory permissions');
      return;
    }
    process.env.EGC_SQLITE_ENGINE = 'wasm';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compat-'));
    const inner = path.join(dir, 'locked');
    fs.mkdirSync(inner);
    const file = path.join(inner, 'state.db');
    try {
      const db = await openCompatDatabase(file, 'test');
      await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
      await db.close();
      fs.writeFileSync(`${file}-wal`, Buffer.alloc(8, 1));
      fs.chmodSync(inner, 0o000);
      await assert.rejects(() => openCompatDatabase(file, 'test'), err => err.code === 'EACCES');
    } finally {
      try { fs.chmodSync(inner, 0o755); } catch { /* already writable */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await test('refuses a file whose write-ahead log still holds data the portable engine cannot read', async () => {
    process.env.EGC_SQLITE_ENGINE = 'wasm';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compat-'));
    const file = path.join(dir, 'state.db');
    try {
      const db = await openCompatDatabase(file, 'test');
      await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
      await db.close();
      fs.writeFileSync(`${file}-wal`, Buffer.alloc(64, 1));
      await assert.rejects(() => openCompatDatabase(file, 'test'), /write-ahead data/);
      fs.writeFileSync(`${file}-wal`, '');
      const empty = await openCompatDatabase(file, 'test');
      await empty.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await test('a failed background persist is reported, not thrown', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      console.log('    - skipped: root ignores directory permissions');
      return;
    }
    process.env.EGC_SQLITE_ENGINE = 'wasm';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compat-'));
    const file = path.join(dir, 'state.db');
    try {
      const db = await openCompatDatabase(file, 'test');
      await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
      await new Promise(r => setTimeout(r, 60));
      fs.chmodSync(dir, 0o555);
      const captured = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return originalWrite.call(process.stderr, chunk, ...rest); };
      try {
        await db.run('INSERT INTO items DEFAULT VALUES');
        await new Promise(r => setTimeout(r, 80));
      } finally {
        process.stderr.write = originalWrite;
      }
      assert.ok(captured.some(line => line.includes('[sqlite-compat] could not persist')), `expected the persist failure on stderr, got: ${captured.join('|').slice(0, 200)}`);
      const rows = await db.all('SELECT COUNT(*) AS n FROM items');
      assert.strictEqual(rows[0].n, 1, 'the in-memory database keeps working');
      fs.chmodSync(dir, 0o755);
      await db.close();
    } finally {
      try { fs.chmodSync(dir, 0o755); } catch { /* already writable */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await test('the native engine is used by default when it loads', async () => {
    delete process.env.EGC_SQLITE_ENGINE;
    let native = true;
    try { require('sqlite3'); } catch { native = false; }
    const db = await openCompatDatabase(':memory:', 'test');
    const row = await db.get('SELECT sqlite_version() AS v');
    assert.ok(row.v);
    assert.strictEqual(typeof db.configure === 'function', native, 'the sqlite package Database carries configure; the portable facade does not');
    await db.close();
  })) passed++; else failed++;

  if (previous === undefined) delete process.env.EGC_SQLITE_ENGINE; else process.env.EGC_SQLITE_ENGINE = previous;
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
