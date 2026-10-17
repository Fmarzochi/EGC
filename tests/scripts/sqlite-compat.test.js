'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openCompatDatabase, isNativeLoadFailure, normalizeParams, mutates, splitStatements } = require('../../scripts/lib/state-store/sqlite-compat');

const { permissionBitsEnforced, withDirMode } = require('../fixtures/dir-permissions');

const COMPAT_PATH = require.resolve('../../scripts/lib/state-store/sqlite-compat');
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

// Runs fn against a fresh copy of the engine chooser while the named
// packages cannot be resolved, the way a checkout looks when its servers
// were built without the root dependencies installed. The engines are
// required lazily, so the interception has to outlive the awaited call.
async function withoutPackages(names, fn) {
  const Module = require('node:module');
  const cached = require.cache[COMPAT_PATH];
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (names.includes(request)) {
      const err = new Error(`Cannot find module '${request}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[COMPAT_PATH];
  try {
    await fn(require(COMPAT_PATH));
  } finally {
    Module._load = originalLoad;
    require.cache[COMPAT_PATH] = cached;
  }
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

// The cases that make a package unresolvable. They run with the engine
// choice left to the chooser, so the native attempt is the first step.
async function runMissingPackageTests() {
  delete process.env.EGC_SQLITE_ENGINE;
  const results = [
    await test('a missing sql.js names the directory to install in instead of a bare module error', async () => {
      await withoutPackages(['sqlite3', 'sql.js'], async compat => {
        await assert.rejects(
          () => compat.openCompatDatabase(':memory:', 'test'),
          err => err.message.includes(PACKAGE_ROOT) && /npm ci/.test(err.message) && /sqlite3 did not load/.test(err.message)
        );
      });
    }),
    await test('missing engines are reported before a pending write-ahead log', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compat-'));
      const file = path.join(dir, 'state.db');
      try {
        fs.writeFileSync(file, '');
        fs.writeFileSync(`${file}-wal`, Buffer.alloc(64, 1));
        await withoutPackages(['sqlite3', 'sql.js'], async compat => {
          await assert.rejects(() => compat.openCompatDatabase(file, 'test'), /npm ci/);
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }),
    await test('a missing sql.js with the portable engine forced keeps the original error as the cause and adds no sqlite3 note', async () => {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      try {
        await withoutPackages(['sql.js'], async compat => {
          await assert.rejects(
            () => compat.openCompatDatabase(':memory:', 'test'),
            err => err.message.includes(PACKAGE_ROOT) && /npm ci/.test(err.message) && !/sqlite3 did not load/.test(err.message) && err.cause?.code === 'MODULE_NOT_FOUND'
          );
        });
      } finally {
        delete process.env.EGC_SQLITE_ENGINE;
      }
    }),
    await test('the fallback is announced only once the portable engine has opened', async () => {
      const captured = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = chunk => { captured.push(String(chunk)); return true; };
      try {
        await withoutPackages(['sqlite3', 'sql.js'], async compat => {
          await assert.rejects(() => compat.openCompatDatabase(':memory:', 'test'), /npm ci/);
        });
      } finally {
        process.stderr.write = originalWrite;
      }
      assert.deepStrictEqual(captured.filter(line => line.includes('using the portable sql.js engine')), []);
    }),
    await test('a missing sqlite3 package alone still falls back to the portable engine', async () => {
      await withoutPackages(['sqlite3'], async compat => {
        const db = await compat.openCompatDatabase(':memory:', 'test');
        assert.strictEqual(compat.selectedEngine(), 'wasm');
        await db.close();
      });
    }),
    await test('a reader falls back without the notice and has no file behind it', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compat-'));
      const file = path.join(dir, 'state.db');
      const captured = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = chunk => { captured.push(String(chunk)); return true; };
      try {
        fs.writeFileSync(file, '');
        const before = fs.statSync(file, { bigint: true });
        await withoutPackages(['sqlite3'], async compat => {
          const db = await compat.openCompatDatabase(file, 'test', { reader: true });
          assert.strictEqual(compat.selectedEngine(), 'wasm');
          await db.exec('CREATE TABLE probe (x)');
          await db.close();
        });
        const after = fs.statSync(file, { bigint: true });
        assert.strictEqual(after.ino, before.ino, 'the file must not be replaced');
        assert.strictEqual(after.size, 0n, 'nothing must be written to the file');
      } finally {
        process.stderr.write = originalWrite;
        fs.rmSync(dir, { recursive: true, force: true });
      }
      assert.deepStrictEqual(captured.filter(line => line.includes('using the portable sql.js engine')), []);
    }),
  ];
  const passed = results.filter(Boolean).length;
  return { passed, failed: results.length - passed };
}

async function runTests() {
  console.log('\n=== Testing sqlite-compat (shared engine chooser) ===\n');
  let passed = 0;
  let failed = 0;
  const previous = process.env.EGC_SQLITE_ENGINE;
  const run = async (name, fn) => {
    if (await test(name, fn)) passed++; else failed++;
  };

  await run('classifies native load failures and nothing else', async () => {
    assert.ok(isNativeLoadFailure(Object.assign(new Error('x'), { code: 'ERR_DLOPEN_FAILED' })));
    assert.ok(isNativeLoadFailure(new Error("/lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found (required by node_sqlite3.node)")));
    assert.ok(isNativeLoadFailure(new Error('Could not locate the bindings file. Tried:')));
    assert.ok(!isNativeLoadFailure(new Error('SQLITE_BUSY: database is locked')));
    assert.ok(!isNativeLoadFailure(null));
  });

  await run('normalizes the three parameter styles the sqlite package accepts', async () => {
    assert.deepStrictEqual(normalizeParams([]), undefined);
    assert.deepStrictEqual(normalizeParams([['a', undefined]]), ['a', null]);
    assert.deepStrictEqual(normalizeParams(['a', 2]), ['a', 2]);
    assert.deepStrictEqual(normalizeParams([{ id: 1, $name: 'n', ':x': undefined }]), { $id: 1, $name: 'n', ':x': null });
    assert.deepStrictEqual(normalizeParams([7]), [7]);
  });

  await run('statements are split on semicolons outside quoted literals and classified conservatively', async () => {
    assert.deepStrictEqual(splitStatements("SELECT 'a;b'; SELECT \"c;d\""), ["SELECT 'a;b'", " SELECT \"c;d\""]);
    assert.strictEqual(mutates("SELECT 'PRAGMA user_version = 3'"), false);
    assert.strictEqual(mutates('PRAGMA user_version'), false);
    assert.strictEqual(mutates('EXPLAIN SELECT 1'), false);
    assert.strictEqual(mutates('PRAGMA optimize'), true);
    assert.strictEqual(mutates('PRAGMA user_version = 7'), true);
    assert.strictEqual(mutates('ANALYZE'), true);
    assert.strictEqual(mutates('WITH s(x) AS (SELECT 1) INSERT INTO t SELECT x FROM s'), true);
    assert.strictEqual(mutates('SELECT 1; UPDATE t SET x = 1'), true);
  });

  await run('a trigger body keeps its inner semicolons and its END does not close an open transaction', async () => {
    const trigger = "CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN INSERT INTO audit VALUES (new.id, 'a;b'); UPDATE items SET flag = CASE WHEN new.id > 1 THEN 1 ELSE 0 END WHERE id = new.id; END";
    assert.deepStrictEqual(splitStatements(`${trigger}; SELECT 1`), [trigger, ' SELECT 1']);
    assert.deepStrictEqual(splitStatements('BEGIN; INSERT INTO t VALUES (1); END'), ['BEGIN', ' INSERT INTO t VALUES (1)', ' END']);
    process.env.EGC_SQLITE_ENGINE = 'wasm';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compat-'));
    const file = path.join(dir, 'state.db');
    try {
      const db = await openCompatDatabase(file, 'test');
      await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, flag INTEGER); CREATE TABLE audit (item_id INTEGER, note TEXT)');
      await db.exec('BEGIN');
      await db.exec(`${trigger};`);
      assert.strictEqual(db._inTransaction, true, 'the END of the trigger must not end the transaction');
      await db.exec('INSERT INTO items (id) VALUES (1); INSERT INTO items (id) VALUES (2)');
      await db.exec('COMMIT');
      assert.strictEqual(db._inTransaction, false);
      await db.close();
      const again = await openCompatDatabase(file, 'test');
      assert.deepStrictEqual(await again.all('SELECT id, flag FROM items ORDER BY id'), [{ id: 1, flag: 0 }, { id: 2, flag: 1 }]);
      assert.deepStrictEqual((await again.all('SELECT note FROM audit ORDER BY item_id')).map(r => r.note), ['a;b', 'a;b']);
      await again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run('a pragma inside a string literal is executed as data, not stripped', async () => {
    process.env.EGC_SQLITE_ENGINE = 'wasm';
    const db = await openCompatDatabase(':memory:', 'test');
    await db.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('PRAGMA synchronous = NORMAL; keep me')");
    const row = await db.get('SELECT body FROM notes');
    assert.strictEqual(row.body, 'PRAGMA synchronous = NORMAL; keep me');
    await db.close();
  });

  await run('the portable engine answers run, get, all and exec and persists to the file', async () => {
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
  });

  await run('exec keeps trigger bodies intact and stops at the first failing statement', async () => {
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
  });

  await run('writes that follow a pragma or start with a CTE are persisted', async () => {
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
  });

  await run('ANALYZE and value-setting pragmas are persisted; SELECT and reporting pragmas are not treated as writes', async () => {
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
  });

  await run('a permission error on the write-ahead log is surfaced, not mistaken for an absent log', async () => {
    if (!permissionBitsEnforced()) {
      console.log('    - skipped: directory permission bits are not enforced here (root, or Windows)');
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
      await withDirMode(inner, 0o000, () => assert.rejects(() => openCompatDatabase(file, 'test'), err => err.code === 'EACCES'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run('refuses a file whose write-ahead log still holds data the portable engine cannot read', async () => {
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
  });

  await run('a write failure due to permissions is thrown to the caller', async () => {
    if (!permissionBitsEnforced()) {
      console.log('    - skipped: directory permission bits are not enforced here (root, or Windows)');
      return;
    }
    process.env.EGC_SQLITE_ENGINE = 'wasm';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compat-'));
    const file = path.join(dir, 'state.db');
    try {
      const db = await openCompatDatabase(file, 'test');
      await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
      await new Promise(r => setTimeout(r, 60));
      await withDirMode(dir, 0o555, () => assert.rejects(
        () => db.run('INSERT INTO items DEFAULT VALUES'),
        /EACCES/
      ));
      await db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run('a persistence failure during persistNow is propagated and releases lock', async () => {
    process.env.EGC_SQLITE_ENGINE = 'wasm';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compat-persist-'));
    const file = path.join(dir, 'state.db');
    try {
      const db = await openCompatDatabase(file, 'test');
      await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
      const originalPersist = db.persistNow.bind(db);
      db.persistNow = () => {
        throw new Error('Disk full during persistNow simulation');
      };
      await assert.rejects(
        () => db.run('INSERT INTO items DEFAULT VALUES'),
        /Disk full during persistNow simulation/
      );
      db.persistNow = originalPersist;
      assert.ok(!fs.existsSync(db.getLockPath()), 'Lock file must be released after persist failure');
      // Subsequent write should succeed cleanly
      await db.run('INSERT INTO items DEFAULT VALUES');
      const rows = await db.all('SELECT COUNT(*) AS count FROM items');
      assert.strictEqual(rows[0].count, 1);
      await db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run('failed first write before file exists resets in-memory database and does not persist later', async () => {
    process.env.EGC_SQLITE_ENGINE = 'wasm';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compat-first-write-'));
    const file = path.join(dir, 'state.db');
    try {
      const db = await openCompatDatabase(file, 'test-first');
      assert.ok(!fs.existsSync(file), 'Database file must not exist before first write');

      // Inject persistence failure on the very first write
      const originalPersist = db.persistNow.bind(db);
      db.persistNow = () => {
        throw new Error('Disk full on first persist simulation');
      };
      await assert.rejects(
        () => db.exec("CREATE TABLE bad_table (id TEXT); INSERT INTO bad_table VALUES ('corrupt');"),
        /Disk full on first persist simulation/
      );

      // Restore persistNow
      db.persistNow = originalPersist;
      assert.ok(!fs.existsSync(file), 'Failed first write must not have created the database file');

      // Now perform a clean, valid first write on the same handle
      await db.exec("CREATE TABLE good_table (id TEXT); INSERT INTO good_table VALUES ('valid');");

      // Verify on disk and in memory that only good_table exists and bad_table was discarded
      const goodRows = await db.all('SELECT * FROM good_table;');
      assert.strictEqual(goodRows.length, 1);
      assert.strictEqual(goodRows[0].id, 'valid');

      // bad_table must NOT exist
      await assert.rejects(
        () => db.all('SELECT * FROM bad_table;'),
        /no such table: bad_table/
      );

      await db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run('the bytes read and the identity recorded come from one handle, so a file renamed over the path is a new identity', async () => {
    const { readFileWithIdentity } = require('../../scripts/lib/state-store/sqlite-compat');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-compat-'));
    const file = path.join(dir, 'state.db');
    try {
      assert.deepStrictEqual(readFileWithIdentity(file), { data: null, mtimeMs: 0, ino: 0 }, 'a missing file has no bytes and no identity');
      fs.writeFileSync(file, 'first');
      const first = readFileWithIdentity(file);
      const stat = fs.statSync(file);
      assert.strictEqual(first.data.toString(), 'first');
      assert.strictEqual(first.ino, stat.ino, 'the identity is the one a stat of the same file reports');
      assert.strictEqual(first.mtimeMs, stat.mtimeMs);
      const replacement = path.join(dir, 'state.db.next');
      fs.writeFileSync(replacement, 'second');
      fs.renameSync(replacement, file);
      const second = readFileWithIdentity(file);
      assert.strictEqual(second.data.toString(), 'second');
      assert.ok(second.ino !== first.ino || second.mtimeMs !== first.mtimeMs, 'the file renamed over the path must carry a new identity');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run('the native engine is used by default when it loads', async () => {
    delete process.env.EGC_SQLITE_ENGINE;
    let native = true;
    try { require('sqlite3'); } catch { native = false; }
    const db = await openCompatDatabase(':memory:', 'test');
    const row = await db.get('SELECT sqlite_version() AS v');
    assert.ok(row.v);
    assert.strictEqual(typeof db.configure === 'function', native, 'the sqlite package Database carries configure; the portable facade does not');
    await db.close();
  });

  const missing = await runMissingPackageTests();
  passed += missing.passed;
  failed += missing.failed;

  if (previous === undefined) delete process.env.EGC_SQLITE_ENGINE; else process.env.EGC_SQLITE_ENGINE = previous;
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
