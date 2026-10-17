'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const {
  createStateStore,
} = require('../../scripts/lib/state-store');
const {
  openCompatDatabase,
} = require('../../scripts/lib/state-store/sqlite-compat');

const PROJECT_ID = 'egc-concurrency-suite';
const HOOK_WRITER_PATH = path.resolve(__dirname, '../../scripts/hooks/state-db-writer.js');
const SQLITE_COMPAT_PATH = path.resolve(__dirname, '../../scripts/lib/state-store/sqlite-compat.js');
const MIGRATIONS_PATH = path.resolve(__dirname, '../../scripts/lib/state-store/migrations.js');

function detectPython3() {
  const result = spawnSync('python3', ['-c', 'import sqlite3; print(sqlite3.sqlite_version)'], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

function detectNativeSqlite() {
  try {
    const sqlite3 = require('sqlite3');
    return { available: true, version: sqlite3.VERSION };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

const PYTHON_AVAILABLE = detectPython3();
const NATIVE_SQLITE = detectNativeSqlite();

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

function testSkip(name, reason) {
  console.log(`  - ${name} (skipped: ${reason})`);
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function buildPythonInsertScript({ dbPath, projectId, count, sleepMs, tag }) {
  const sleepSeconds = sleepMs / 1000;
  return [
    'import sqlite3, sys, time, uuid',
    `db_path = ${JSON.stringify(dbPath)}`,
    `project_id = ${JSON.stringify(projectId)}`,
    `count = ${count}`,
    `sleep_seconds = ${sleepSeconds}`,
    `tag = ${JSON.stringify(tag)}`,
    'conn = sqlite3.connect(db_path, timeout=5.0)',
    'try:',
    '    for i in range(count):',
    '        row_id = "py-" + tag + "-" + uuid.uuid4().hex',
    '        created_at = "2026-05-18T00:00:00.000Z"',
    '        conn.execute(',
    '            "INSERT INTO instincts (id, project_id, trigger, content, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",',
    '            (row_id, project_id, "PostToolUse:Edit", "python-write-" + str(i), 0.5, created_at, None),',
    '        )',
    '        conn.commit()',
    '        if sleep_seconds > 0:',
    '            time.sleep(sleep_seconds)',
    'finally:',
    '    conn.close()',
    'sys.stdout.write("OK")',
  ].join('\n');
}

function runPythonInsertsSync({ dbPath, projectId, count, sleepMs, tag }) {
  const script = buildPythonInsertScript({ dbPath, projectId, count, sleepMs, tag });
  return spawnSync('python3', ['-c', script], { encoding: 'utf8' });
}

function spawnPythonInserts({ dbPath, projectId, count, sleepMs, tag }) {
  const script = buildPythonInsertScript({ dbPath, projectId, count, sleepMs, tag });
  const child = spawn('python3', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exitPromise = new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`python3 exited with code ${code}: ${stderr}`));
      }
    });
  });
  return { child, exitPromise };
}

async function insertNodeRows(dbPath, count, tag) {
  const store = await createStateStore({ dbPath });
  try {
    for (let i = 0; i < count; i += 1) {
      store.upsertInstinct({
        id: `node-${tag}-${crypto.randomUUID()}`,
        projectId: PROJECT_ID,
        trigger: 'PostToolUse:Edit',
        content: `node-write-${i}`,
        confidence: 0.5,
        createdAt: '2026-05-18T00:00:00.000Z',
      });
    }
  } finally {
    store.close();
  }
}

async function countInstincts(dbPath) {
  const store = await createStateStore({ dbPath });
  try {
    const result = store.listInstincts({ projectId: PROJECT_ID, limit: 1000 });
    return {
      totalCount: result.totalCount,
      rows: result.instincts,
    };
  } finally {
    store.close();
  }
}

function classifyRows(rows) {
  let python = 0;
  let node = 0;
  for (const row of rows) {
    if (row.id.startsWith('py-')) python += 1;
    else if (row.id.startsWith('node-')) node += 1;
  }
  return { python, node };
}

async function detectWalSupport() {
  const tempDir = createTempDir('egc-wal-detect-');
  const dbPath = path.join(tempDir, 'detect.db');
  try {
    const store = await createStateStore({ dbPath });
    const supported = store._database._supportsWal === true;
    store.close();
    return supported;
  } finally {
    cleanupTempDir(tempDir);
  }
}

async function runTests() {
  console.log('\n=== Testing state-store concurrency (hook writer, sqlite-compat, multi-process) ===\n');

  let passed = 0;
  let failed = 0;

  const originalEnvEngine = process.env.EGC_SQLITE_ENGINE;

  const runCase = async (name, fn) => {
    const savedEngine = process.env.EGC_SQLITE_ENGINE;
    try {
      if (await test(name, fn)) passed += 1; else failed += 1;
    } finally {
      if (savedEngine === undefined) {
        delete process.env.EGC_SQLITE_ENGINE;
      } else {
        process.env.EGC_SQLITE_ENGINE = savedEngine;
      }
    }
  };

  // 1. Regression test: Concurrent state-db-writer hook processes
  await runCase('test_concurrent_hook_writers_lost_updates', async () => {
    const tempDir = createTempDir('egc-conc-hook-');
    const egcDir = path.join(tempDir, 'egc');
    fs.mkdirSync(egcDir, { recursive: true });
    const dbPath = path.join(egcDir, 'state.db');

    try {
      // Bootstrap state database with schema and migrations
      const bootstrap = await createStateStore({ dbPath });
      bootstrap.close();

      const CONCURRENT_WORKERS = 10;
      const promises = [];

      for (let i = 0; i < CONCURRENT_WORKERS; i += 1) {
        const p = new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [HOOK_WRITER_PATH], {
            env: {
              ...process.env,
              EGC_DIR: tempDir,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          let stderr = '';
          child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
          child.on('error', reject);
          child.on('close', code => {
            resolve({ code, stderr, index: i });
          });

          const payload = {
            session_id: `session-worker-${i}`,
            event_type: `tool_use_worker_${i}`,
            hook_event_name: 'test_hook',
            payload: { workerIndex: i, testUuid: crypto.randomUUID() },
          };
          child.stdin.end(JSON.stringify(payload));
        });
        promises.push(p);
      }

      const results = await Promise.all(promises);
      for (const res of results) {
        assert.strictEqual(
          res.code,
          0,
          `hook writer worker ${res.index} exited with non-zero code ${res.code}: ${res.stderr}`
        );
      }

      // Verify database integrity
      const verifyDb = await openCompatDatabase(dbPath, 'verify');
      try {
        const integrityRows = await verifyDb.all('PRAGMA integrity_check');
        const integrityStatus = integrityRows[0] ? (integrityRows[0].integrity_check || Object.values(integrityRows[0])[0]) : null;
        assert.strictEqual(integrityStatus, 'ok', `integrity_check failed: ${JSON.stringify(integrityRows)}`);

        const events = await verifyDb.all('SELECT id, session_id, event_type FROM events');
        const uniqueSessions = new Set(events.map(e => e.session_id));

        console.log(`    hook_writer_results: expected=${CONCURRENT_WORKERS} actual=${events.length} unique_sessions=${uniqueSessions.size}`);

        assert.strictEqual(
          events.length,
          CONCURRENT_WORKERS,
          `Expected ${CONCURRENT_WORKERS} events after concurrent hook writes, but got ${events.length} (lost-update race occurred: ${CONCURRENT_WORKERS - events.length} events lost)`
        );
        assert.strictEqual(
          uniqueSessions.size,
          CONCURRENT_WORKERS,
          `Expected ${CONCURRENT_WORKERS} unique sessions, got ${uniqueSessions.size}`
        );
      } finally {
        await verifyDb.close();
      }
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  // 2. Regression test: Concurrent WASM compat writers (WasmDatabase)
  await runCase('test_concurrent_wasm_compat_writers_lost_updates', async () => {
    const tempDir = createTempDir('egc-conc-wasm-');
    const dbPath = path.join(tempDir, 'state_wasm.db');

    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const initDb = await openCompatDatabase(dbPath, 'init');
      await initDb.exec(`
        CREATE TABLE IF NOT EXISTS test_records (
          id TEXT PRIMARY KEY,
          worker_id INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      await initDb.close();

      const CONCURRENT_WORKERS = 10;
      const promises = [];

      for (let i = 0; i < CONCURRENT_WORKERS; i += 1) {
        const workerScript = `
          const { openCompatDatabase } = require(${JSON.stringify(SQLITE_COMPAT_PATH)});
          async function run() {
            process.env.EGC_SQLITE_ENGINE = 'wasm';
            const db = await openCompatDatabase(${JSON.stringify(dbPath)}, 'worker-${i}');
            await db.run(
              'INSERT INTO test_records (id, worker_id, created_at) VALUES (?, ?, ?)',
              ['wasm-worker-${i}', ${i}, new Date().toISOString()]
            );
            await db.close();
          }
          run().catch(err => {
            console.error(err);
            process.exit(1);
          });
        `;

        const p = new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['-e', workerScript], {
            env: { ...process.env, EGC_SQLITE_ENGINE: 'wasm' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
          child.on('error', reject);
          child.on('close', code => resolve({ code, stderr, index: i }));
        });
        promises.push(p);
      }

      const results = await Promise.all(promises);
      for (const res of results) {
        assert.strictEqual(
          res.code,
          0,
          `WASM worker ${res.index} exited with non-zero code ${res.code}: ${res.stderr}`
        );
      }

      const verifyDb = await openCompatDatabase(dbPath, 'verify');
      try {
        const integrityRows = await verifyDb.all('PRAGMA integrity_check');
        const integrityStatus = integrityRows[0] ? (integrityRows[0].integrity_check || Object.values(integrityRows[0])[0]) : null;
        assert.strictEqual(integrityStatus, 'ok', `integrity_check failed: ${JSON.stringify(integrityRows)}`);

        const rows = await verifyDb.all('SELECT id, worker_id FROM test_records');
        console.log(`    wasm_compat_results: expected=${CONCURRENT_WORKERS} actual=${rows.length}`);

        assert.strictEqual(
          rows.length,
          CONCURRENT_WORKERS,
          `Expected ${CONCURRENT_WORKERS} rows after concurrent WASM writes, but got ${rows.length} (lost-update race occurred: ${CONCURRENT_WORKERS - rows.length} writes lost)`
        );
      } finally {
        await verifyDb.close();
      }
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  // A case that needs the native sqlite3 engine is skipped, with the reason, where it did not load.
  const runNativeCase = async (name, fn) => {
    if (!NATIVE_SQLITE.available) {
      testSkip(name, `Native sqlite3 engine is not available in this environment (${NATIVE_SQLITE.reason})`);
      return;
    }
    await runCase(name, fn);
  };

  // 3. Regression test: Concurrent native compat writers
  await runNativeCase('test_concurrent_native_compat_writers', async () => {
      const tempDir = createTempDir('egc-conc-native-');
      const dbPath = path.join(tempDir, 'state_native.db');

      try {
        process.env.EGC_SQLITE_ENGINE = 'native';
        const initDb = await openCompatDatabase(dbPath, 'init');
        await initDb.exec(`
          CREATE TABLE IF NOT EXISTS test_records (
            id TEXT PRIMARY KEY,
            worker_id INTEGER NOT NULL,
            created_at TEXT NOT NULL
          );
        `);
        await initDb.close();

        const CONCURRENT_WORKERS = 10;
        const promises = [];

        for (let i = 0; i < CONCURRENT_WORKERS; i += 1) {
          const workerScript = `
            const { openCompatDatabase } = require(${JSON.stringify(SQLITE_COMPAT_PATH)});
            async function run() {
              process.env.EGC_SQLITE_ENGINE = 'native';
              const db = await openCompatDatabase(${JSON.stringify(dbPath)}, 'worker-${i}');
              await db.run(
                'INSERT INTO test_records (id, worker_id, created_at) VALUES (?, ?, ?)',
                ['native-worker-${i}', ${i}, new Date().toISOString()]
              );
              await db.close();
            }
            run().catch(err => {
              console.error(err);
              process.exit(1);
            });
          `;

          const p = new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', workerScript], {
              env: { ...process.env, EGC_SQLITE_ENGINE: 'native' },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
            child.on('error', reject);
            child.on('close', code => resolve({ code, stderr, index: i }));
          });
          promises.push(p);
        }

        const results = await Promise.all(promises);
        for (const res of results) {
          assert.strictEqual(
            res.code,
            0,
            `Native worker ${res.index} exited with non-zero code ${res.code}: ${res.stderr}`
          );
        }

        const verifyDb = await openCompatDatabase(dbPath, 'verify');
        try {
          const integrityRows = await verifyDb.all('PRAGMA integrity_check');
          const integrityStatus = integrityRows[0] ? (integrityRows[0].integrity_check || Object.values(integrityRows[0])[0]) : null;
          assert.strictEqual(integrityStatus, 'ok', `integrity_check failed: ${JSON.stringify(integrityRows)}`);

          const rows = await verifyDb.all('SELECT id, worker_id FROM test_records');
          console.log(`    native_compat_results: expected=${CONCURRENT_WORKERS} actual=${rows.length}`);

          assert.strictEqual(
            rows.length,
            CONCURRENT_WORKERS,
            `Expected ${CONCURRENT_WORKERS} rows after concurrent native writes, but got ${rows.length}`
          );
        } finally {
          await verifyDb.close();
        }
      } finally {
        cleanupTempDir(tempDir);
      }
  });

  // 4. Native WAL vs db-adapter (WASM) mixed-engine collision risk
  await runNativeCase('test_mixed_engine_uncoordinated_writes_risk', async () => {
      const tempDir = createTempDir('egc-conc-mixed-');
      const dbPath = path.join(tempDir, 'state_mixed.db');

      try {
        process.env.EGC_SQLITE_ENGINE = 'native';
        const nativeDb = await openCompatDatabase(dbPath, 'native-writer');
        await nativeDb.exec('PRAGMA journal_mode = WAL;');
        await nativeDb.exec('CREATE TABLE test_shared (id TEXT PRIMARY KEY, val TEXT);');
        await nativeDb.run('INSERT INTO test_shared VALUES (?, ?)', ['n1', 'native-val-1']);
        await nativeDb.close();

        // Check if WAL file exists with uncheckpointed data
        const walPath = `${dbPath}-wal`;
        const walExists = fs.existsSync(walPath);
        console.log(`    native_wal_exists: ${walExists}`);

        // Hook writer uses db-adapter (WASM sql.js), which opens with fs.readFileSync(dbPath)
        // and does not understand WAL sidecars.
        const wasmStore = await createStateStore({ dbPath });
        try {
          // If uncoordinated mixed engine writes occur, wasmStore reads stale snapshot
          // without WAL changes and rewrites whole file on export, clobbering native WAL.
          const walSupported = wasmStore._database._supportsWal === true;
          assert.strictEqual(
            walSupported,
            false,
            'db-adapter currently does not support WAL mode; concurrent native WAL + WASM writes are unsafe without coordination'
          );
        } finally {
          wasmStore.close();
        }
      } finally {
        cleanupTempDir(tempDir);
      }
  });

  // 5. Test concurrent migrations startup (multi-process migration race)
  await runCase('test_concurrent_migrations_startup_wasm', async () => {
    const tempDir = createTempDir('egc-mig-wasm-');
    const dbPath = path.join(tempDir, 'state_mig_wasm.db');

    try {
      const CONCURRENT_WORKERS = 10;
      const promises = [];

      for (let i = 0; i < CONCURRENT_WORKERS; i += 1) {
        const workerScript = `
          const { openCompatDatabase } = require(${JSON.stringify(SQLITE_COMPAT_PATH)});
          const { applyMigrationsAsync } = require(${JSON.stringify(MIGRATIONS_PATH)});
          async function run() {
            process.env.EGC_SQLITE_ENGINE = 'wasm';
            const db = await openCompatDatabase(${JSON.stringify(dbPath)}, 'mig-worker-${i}');
            await applyMigrationsAsync(db);
            await db.close();
          }
          run().then(() => process.exit(0)).catch(err => {
            console.error(err);
            process.exit(1);
          });
        `;

        const p = new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['-e', workerScript], {
            env: { ...process.env, EGC_SQLITE_ENGINE: 'wasm' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
          child.on('error', reject);
          child.on('close', code => resolve({ code, stderr, index: i }));
        });
        promises.push(p);
      }

      const results = await Promise.all(promises);
      for (const res of results) {
        assert.strictEqual(
          res.code,
          0,
          `Migration worker ${res.index} exited with code ${res.code}: ${res.stderr}`
        );
      }

      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const verifyDb = await openCompatDatabase(dbPath, 'verify');
      try {
        const integrityRows = await verifyDb.all('PRAGMA integrity_check');
        const integrityStatus = integrityRows[0] ? (integrityRows[0].integrity_check || Object.values(integrityRows[0])[0]) : null;
        assert.strictEqual(integrityStatus, 'ok', `integrity_check failed: ${JSON.stringify(integrityRows)}`);

        const migrations = await verifyDb.all('SELECT version, name FROM schema_migrations ORDER BY version ASC');
        assert.deepStrictEqual(
          migrations.map(row => row.version),
          [1, 2, 3, 4, 5, 6],
          'All 6 WASM migrations must be recorded in schema_migrations in ascending order'
        );
      } finally {
        await verifyDb.close();
      }
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  if (NATIVE_SQLITE.available) {
    await runCase('test_concurrent_migrations_startup_native', async () => {
      const tempDir = createTempDir('egc-mig-native-');
      const dbPath = path.join(tempDir, 'state_mig_native.db');

      try {
        const CONCURRENT_WORKERS = 10;
        const promises = [];

        for (let i = 0; i < CONCURRENT_WORKERS; i += 1) {
          const workerScript = `
            const { openCompatDatabase } = require(${JSON.stringify(SQLITE_COMPAT_PATH)});
            const { applyMigrationsAsync } = require(${JSON.stringify(MIGRATIONS_PATH)});
            async function run() {
              process.env.EGC_SQLITE_ENGINE = 'native';
              const db = await openCompatDatabase(${JSON.stringify(dbPath)}, 'mig-worker-${i}');
              await applyMigrationsAsync(db);
              await db.close();
            }
            run().then(() => process.exit(0)).catch(err => {
              console.error(err);
              process.exit(1);
            });
          `;

          const p = new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', workerScript], {
              env: { ...process.env, EGC_SQLITE_ENGINE: 'native' },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
            child.on('error', reject);
            child.on('close', code => resolve({ code, stderr, index: i }));
          });
          promises.push(p);
        }

        const results = await Promise.all(promises);
        for (const res of results) {
          assert.strictEqual(
            res.code,
            0,
            `Native migration worker ${res.index} exited with code ${res.code}: ${res.stderr}`
          );
        }

        process.env.EGC_SQLITE_ENGINE = 'native';
        const verifyDb = await openCompatDatabase(dbPath, 'verify');
        try {
          const integrityRows = await verifyDb.all('PRAGMA integrity_check');
          const integrityStatus = integrityRows[0] ? (integrityRows[0].integrity_check || Object.values(integrityRows[0])[0]) : null;
          assert.strictEqual(integrityStatus, 'ok', `integrity_check failed: ${JSON.stringify(integrityRows)}`);

          const migrations = await verifyDb.all('SELECT version, name FROM schema_migrations ORDER BY version ASC');
          assert.deepStrictEqual(
            migrations.map(row => row.version),
            [1, 2, 3, 4, 5, 6],
            'All 6 native migrations must be recorded in schema_migrations in ascending order'
          );
        } finally {
          await verifyDb.close();
        }
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  }

  // 6. Test mixed-engine safety: WASM refusing uncheckpointed WAL file
  await runCase('test_mixed_engine_safety_uncheckpointed_wal_refusal', async () => {
    const tempDir = createTempDir('egc-mixed-safe-');
    const dbPath = path.join(tempDir, 'state_uncheckpointed.db');
    const walPath = `${dbPath}-wal`;

    try {
      fs.writeFileSync(dbPath, Buffer.alloc(100));
      fs.writeFileSync(walPath, Buffer.alloc(64, 1));

      process.env.EGC_SQLITE_ENGINE = 'wasm';
      let caughtError = null;
      try {
        await openCompatDatabase(dbPath, 'wasm-test');
      } catch (err) {
        caughtError = err;
      }

      assert.ok(caughtError !== null, 'Expected openCompatDatabase to throw on non-empty WAL file');
      assert.match(
        caughtError.message,
        /write-ahead data/,
        `Expected error message mentioning write-ahead data, got: ${caughtError.message}`
      );
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  // 7. Test MCP server style concurrency with simultaneous hook writers
  await runCase('test_mcp_server_style_concurrency_with_hook_writers', async () => {
    const tempDir = createTempDir('egc-server-hook-');
    const egcDir = path.join(tempDir, 'egc');
    fs.mkdirSync(egcDir, { recursive: true });
    const dbPath = path.join(egcDir, 'state.db');

    try {
      const bootstrap = await openCompatDatabase(dbPath, 'bootstrap');
      const { applyMigrationsAsync } = require(MIGRATIONS_PATH);
      await applyMigrationsAsync(bootstrap);
      await bootstrap.close();

      const SERVER_TRANSACTIONS = 5;
      const serverWorkerScript = `
        const { openCompatDatabase, selectedEngine } = require(${JSON.stringify(SQLITE_COMPAT_PATH)});
        async function run() {
          const db = await openCompatDatabase(${JSON.stringify(dbPath)}, 'simulated-mcp-server');
          if (selectedEngine() === 'native') {
            await db.exec('PRAGMA busy_timeout = 5000;');
            await db.exec('PRAGMA journal_mode = WAL;');
            await db.exec('PRAGMA synchronous = NORMAL;');
          }
          for (let i = 0; i < ${SERVER_TRANSACTIONS}; i += 1) {
            await db.exec('BEGIN IMMEDIATE');
            await db.run(
              'INSERT INTO decisions (id, session_id, title, rationale, alternatives, supersedes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              ['dec-' + i, 'sess-server', 'title-' + i, 'rationale-' + i, '[]', null, 'approved', new Date().toISOString()]
            );
            await new Promise(r => setTimeout(r, 20));
            await db.exec('COMMIT');
          }
          await db.close();
        }
        run().then(() => process.exit(0)).catch(err => {
          console.error(err);
          process.exit(1);
        });
      `;

      const serverChild = spawn(process.execPath, ['-e', serverWorkerScript], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let serverStderr = '';
      serverChild.stderr.on('data', chunk => { serverStderr += chunk.toString('utf8'); });
      const serverPromise = new Promise((resolve, reject) => {
        serverChild.on('error', reject);
        serverChild.on('close', code => resolve({ code, stderr: serverStderr }));
      });

      const HOOK_WORKERS = 5;
      const hookPromises = [];
      for (let i = 0; i < HOOK_WORKERS; i += 1) {
        const hp = new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [HOOK_WRITER_PATH], {
            env: {
              ...process.env,
              EGC_DIR: tempDir,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
          child.on('error', reject);
          child.on('close', code => resolve({ code, stderr, index: i }));

          const payload = {
            session_id: 'session-hook-' + i,
            event_type: 'tool_use_hook_' + i,
            hook_event_name: 'test_hook',
            payload: { hookIndex: i, testUuid: crypto.randomUUID() },
          };
          child.stdin.end(JSON.stringify(payload));
        });
        hookPromises.push(hp);
      }

      const [serverResult, hookResults] = await Promise.all([
        serverPromise,
        Promise.all(hookPromises),
      ]);

      assert.strictEqual(
        serverResult.code,
        0,
        `Simulated MCP server failed with code ${serverResult.code}: ${serverResult.stderr}`
      );

      for (const hr of hookResults) {
        assert.strictEqual(
          hr.code,
          0,
          `Hook worker ${hr.index} failed with code ${hr.code}: ${hr.stderr}`
        );
      }

      const verifyDb = await openCompatDatabase(dbPath, 'verify');
      try {
        const integrityRows = await verifyDb.all('PRAGMA integrity_check');
        const integrityStatus = integrityRows[0] ? (integrityRows[0].integrity_check || Object.values(integrityRows[0])[0]) : null;
        assert.strictEqual(integrityStatus, 'ok', `integrity_check failed: ${JSON.stringify(integrityRows)}`);

        const decisions = await verifyDb.all('SELECT id FROM decisions');
        const events = await verifyDb.all('SELECT id FROM events');

        console.log('    server_hook_results: decisions=' + decisions.length + '/' + SERVER_TRANSACTIONS + ' events=' + events.length + '/' + HOOK_WORKERS);
        assert.strictEqual(decisions.length, SERVER_TRANSACTIONS, 'Expected ' + SERVER_TRANSACTIONS + ' decisions from server');
        assert.strictEqual(events.length, HOOK_WORKERS, 'Expected ' + HOOK_WORKERS + ' events from hooks');
      } finally {
        await verifyDb.close();
      }
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  // 8. Test concurrent startup against an existing initialized database
  await runCase('test_concurrent_startup_existing_database', async () => {
    const tempDir = createTempDir('egc-mig-existing-');
    const dbPath = path.join(tempDir, 'state_existing.db');

    try {
      const initDb = await openCompatDatabase(dbPath, 'init');
      const { applyMigrationsAsync } = require(MIGRATIONS_PATH);
      await applyMigrationsAsync(initDb);
      await initDb.run(
        'INSERT INTO sessions (id, adapter_id, harness, state, snapshot) VALUES (?, ?, ?, ?, ?)',
        ['existing-session-1', 'test-adapter', 'test-harness', 'active', '{}']
      );
      await initDb.close();

      const CONCURRENT_WORKERS = 10;
      const promises = [];

      for (let i = 0; i < CONCURRENT_WORKERS; i += 1) {
        const workerScript = `
          const { openCompatDatabase } = require(${JSON.stringify(SQLITE_COMPAT_PATH)});
          const { applyMigrationsAsync } = require(${JSON.stringify(MIGRATIONS_PATH)});
          async function run() {
            const db = await openCompatDatabase(${JSON.stringify(dbPath)}, 'worker-${i}');
            await applyMigrationsAsync(db);
            const row = await db.get('SELECT id FROM sessions WHERE id = ?', ['existing-session-1']);
            if (!row || row.id !== 'existing-session-1') throw new Error('Existing row not found');
            await db.close();
          }
          run().then(() => process.exit(0)).catch(err => {
            console.error(err);
            process.exit(1);
          });
        `;

        const p = new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['-e', workerScript], {
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
          child.on('error', reject);
          child.on('close', code => resolve({ code, stderr, index: i }));
        });
        promises.push(p);
      }

      const results = await Promise.all(promises);
      for (const res of results) {
        assert.strictEqual(
          res.code,
          0,
          `Worker ${res.index} failed on existing DB: ${res.stderr}`
        );
      }

      const verifyDb = await openCompatDatabase(dbPath, 'verify');
      try {
        const row = await verifyDb.get('SELECT id FROM sessions WHERE id = ?', ['existing-session-1']);
        assert.strictEqual(row.id, 'existing-session-1', 'Existing row must remain intact');
      } finally {
        await verifyDb.close();
      }
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  // 9. Actual MCP memory server integration test
  const MEMORY_SERVER_BUILT = fs.existsSync(path.resolve(__dirname, '../../mcp/servers/egc-memory/build/index.js'));
  if (!MEMORY_SERVER_BUILT) {
    testSkip('test_actual_egc_memory_mcp_server_integration', 'mcp/servers/egc-memory/build/index.js not found');
  } else {
    await runCase('test_actual_egc_memory_mcp_server_integration', async () => {
      const { startMemoryServer, initialize: initMemServer, callTool: callMemTool } = require('../fixtures/memory-server-client');
      const tempHome = createTempDir('egc-mcp-home-');
      const projectDir = path.join(tempHome, 'test-project');
      fs.mkdirSync(projectDir, { recursive: true });

      const server = startMemoryServer({
        home: tempHome,
        projectDir,
        env: { EGC_PROJECT: projectDir },
      });

      try {
        await initMemServer(server, 'mcp-integration-test');

        await callMemTool(server, 'store_decision', {
          project_path: projectDir,
          context: 'concurrency verification',
          decision: 'atomic multi-process SQLite coordination verified',
        });

        const searchOutput = await callMemTool(server, 'search_history', {
          query: 'atomic multi-process',
        });
        assert.ok(
          searchOutput.includes('atomic multi-process SQLite coordination verified'),
          `Expected decision in search output, got: ${searchOutput}`
        );

        const dbPath = path.join(tempHome, '.egc', 'memory', 'state.db');
        assert.ok(fs.existsSync(dbPath), 'egc-memory state.db must exist');

        const db = await openCompatDatabase(dbPath, 'verify-mcp');
        try {
          const integrityRows = await db.all('PRAGMA integrity_check');
          const integrityStatus = integrityRows[0] ? (integrityRows[0].integrity_check || Object.values(integrityRows[0])[0]) : null;
          assert.strictEqual(integrityStatus, 'ok', `integrity_check failed on egc-memory db: ${JSON.stringify(integrityRows)}`);
        } finally {
          await db.close();
        }
      } finally {
        await server.stop();
        cleanupTempDir(tempHome);
      }
    });
  }

  // 10. Preserved Python + Node tests
  const WAL_SUPPORTED = await detectWalSupport();

  if (!PYTHON_AVAILABLE) {
    testSkip('test_python_writes_survive_subsequent_node_open', 'python3 not available in this environment');
    testSkip('test_concurrent_node_python_writes_no_lost_writes', 'python3 not available in this environment');
  } else {
    await runCase('test_python_writes_survive_subsequent_node_open', async () => {
      const tempDir = createTempDir('egc-conc-baseline-');
      const dbPath = path.join(tempDir, 'state.db');
      try {
        const bootstrap = await createStateStore({ dbPath });
        bootstrap.close();

        const result = runPythonInsertsSync({
          dbPath,
          projectId: PROJECT_ID,
          count: 50,
          sleepMs: 0,
          tag: 'baseline',
        });
        assert.strictEqual(result.status, 0, `python3 stderr: ${result.stderr}`);

        const counted = await countInstincts(dbPath);
        const split = classifyRows(counted.rows);
        console.log(`    python_rows=${split.python} node_rows=${split.node} total=${counted.totalCount}`);
        assert.ok(counted.totalCount >= 50, `expected >= 50 rows after python writes, got ${counted.totalCount}`);
        assert.ok(split.python >= 50, `expected >= 50 python rows, got ${split.python}`);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    if (!WAL_SUPPORTED) {
      testSkip(
        'test_concurrent_node_python_writes_no_lost_writes',
        'database adapter uses in-memory model without WAL; concurrent external writes not supported'
      );
    } else {
      await runCase('test_concurrent_node_python_writes_no_lost_writes', async () => {
        const tempDir = createTempDir('egc-conc-race-');
        const dbPath = path.join(tempDir, 'state.db');
        try {
          const bootstrap = await createStateStore({ dbPath });
          bootstrap.close();

          const { exitPromise } = spawnPythonInserts({
            dbPath,
            projectId: PROJECT_ID,
            count: 50,
            sleepMs: 5,
            tag: 'race',
          });

          await insertNodeRows(dbPath, 50, 'race');

          await exitPromise;

          const counted = await countInstincts(dbPath);
          const split = classifyRows(counted.rows);
          console.log(`    python_rows=${split.python} node_rows=${split.node} total=${counted.totalCount}`);
          assert.ok(
            counted.totalCount >= 99,
            `expected >= 99 rows after concurrent writes, got total=${counted.totalCount} (python=${split.python} node=${split.node})`,
          );
        } finally {
          cleanupTempDir(tempDir);
        }
      });
    }
  }

  if (!WAL_SUPPORTED) {
    testSkip(
      'test_wal_mode_active_on_real_file_db',
      'database adapter uses in-memory model; WAL journal mode not applicable'
    );
  } else {
    await runCase('test_wal_mode_active_on_real_file_db', async () => {
      const tempDir = createTempDir('egc-conc-wal-');
      const dbPath = path.join(tempDir, 'state.db');
      try {
        const store = await createStateStore({ dbPath });
        try {
          const pragmaResult = store._database.pragma('journal_mode');
          let mode = null;
          if (Array.isArray(pragmaResult) && pragmaResult.length > 0) {
            mode = pragmaResult[0].journal_mode;
          } else if (typeof pragmaResult === 'string') {
            mode = pragmaResult;
          } else if (pragmaResult && typeof pragmaResult === 'object') {
            mode = pragmaResult.journal_mode;
          }
          const modeStr = mode ? String(mode).toLowerCase() : '';
          console.log(`    journal_mode=${modeStr}`);
          assert.ok(modeStr.includes('wal'), `expected journal_mode to include 'wal', got '${modeStr}'`);
        } finally {
          store.close();
        }
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  }

  // 11. Regression test: Composite SQL transaction handling in WasmDatabase.exec()
  await runCase('test_composite_sql_transactions', async () => {
    const tempDir = createTempDir('egc-comp-tx-');
    const dbPath = path.join(tempDir, 'state_comp.db');

    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const db = await openCompatDatabase(dbPath, 'test-comp');
      try {
        await db.run('CREATE TABLE test_tx (id TEXT PRIMARY KEY, val TEXT);');

        // Test single-line BEGIN ... COMMIT
        await db.exec("BEGIN; INSERT INTO test_tx VALUES ('k1', 'v1'); COMMIT;");
        assert.strictEqual(db._inTransaction, false, 'Transaction flag must be false after composite commit');
        assert.strictEqual(db._txToken, null, 'Lock token must be null after composite commit');
        assert.ok(!fs.existsSync(db.getLockPath()), 'Lock file must be released after composite commit');

        // Verify write persisted to disk
        const verifyDb = await openCompatDatabase(dbPath, 'verify-comp');
        const rows = await verifyDb.all('SELECT * FROM test_tx;');
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].id, 'k1');
        await verifyDb.close();

        // Test single-line BEGIN ... ROLLBACK
        await db.exec("BEGIN; INSERT INTO test_tx VALUES ('k2', 'v2'); ROLLBACK;");
        assert.strictEqual(db._inTransaction, false, 'Transaction flag must be false after composite rollback');
        assert.strictEqual(db._txToken, null, 'Lock token must be null after composite rollback');
        assert.ok(!fs.existsSync(db.getLockPath()), 'Lock file must be released after composite rollback');

        // Verify k2 was not persisted
        const rowsAfterRollback = await db.all('SELECT * FROM test_tx;');
        assert.strictEqual(rowsAfterRollback.length, 1);
        assert.strictEqual(rowsAfterRollback[0].id, 'k1');

        // Test composite transaction with comments containing semicolons and strings containing semicolons
        await db.exec(`
          -- comment with semicolon; and another note;
          /* block comment; with semicolon; */
          BEGIN;
          INSERT INTO test_tx VALUES ('k3', 'val;with;semicolons');
          COMMIT;
        `);
        assert.strictEqual(db._inTransaction, false, 'Transaction flag must be false after commented commit');
        assert.ok(!fs.existsSync(db.getLockPath()), 'Lock file must be released');
        const rowsWithSemicolons = await db.all("SELECT * FROM test_tx WHERE id = 'k3';");
        assert.strictEqual(rowsWithSemicolons.length, 1);
        assert.strictEqual(rowsWithSemicolons[0].val, 'val;with;semicolons');
      } finally {
        await db.close();
      }
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  // 12. Regression test: Partially migrated schema with duplicate column
  await runCase('test_partially_migrated_schema_duplicate_column', async () => {
    const tempDir = createTempDir('egc-part-mig-');
    const dbPath = path.join(tempDir, 'state_part.db');

    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const db = await openCompatDatabase(dbPath, 'test-mig');
      try {
        const { applyMigrationsAsync } = require(MIGRATIONS_PATH);

        // Bootstrap schema migrations up to version 5 manually,
        // but simulate an older store that already had 'input_tokens' added to 'sessions'
        await db.exec(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            adapter_id TEXT NOT NULL,
            harness TEXT NOT NULL,
            state TEXT NOT NULL,
            repo_root TEXT,
            started_at TEXT,
            ended_at TEXT,
            snapshot TEXT NOT NULL,
            input_tokens INTEGER
          );
          INSERT INTO schema_migrations VALUES (1, '001_initial_state_store', datetime('now'));
          INSERT INTO schema_migrations VALUES (2, '002_instincts_and_events', datetime('now'));
          INSERT INTO schema_migrations VALUES (3, '003_lessons_confidence_decay', datetime('now'));
          INSERT INTO schema_migrations VALUES (4, '004_patterns', datetime('now'));
          INSERT INTO schema_migrations VALUES (5, '005_events_compressed_at', datetime('now'));
        `);

        // Now run applyMigrationsAsync: should tolerate duplicate column on input_tokens,
        // add output_tokens/total_tokens/token_cost, record version 6, and commit
        await applyMigrationsAsync(db);

        const recorded = await db.all('SELECT version FROM schema_migrations ORDER BY version ASC;');
        assert.deepStrictEqual(
          recorded.map(r => r.version),
          [1, 2, 3, 4, 5, 6],
          'Migration 6 must be recorded even if input_tokens column already existed'
        );

        // Verify remaining columns were added and are writable
        await db.run(
          'INSERT INTO sessions (id, adapter_id, harness, state, snapshot, input_tokens, output_tokens, total_tokens, token_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
          ['s1', 'a1', 'h1', 'active', '{}', 10, 20, 30, 0.05]
        );
        const sessionRow = await db.get('SELECT * FROM sessions WHERE id = ?;', ['s1']);
        assert.strictEqual(sessionRow.input_tokens, 10);
        assert.strictEqual(sessionRow.output_tokens, 20);
        assert.strictEqual(sessionRow.total_tokens, 30);
        assert.ok(Math.abs(sessionRow.token_cost - 0.05) < 1e-9, `token_cost must round-trip, got ${sessionRow.token_cost}`);
      } finally {
        await db.close();
      }
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  // 13. Test mixed-engine safety: WASM refusing database with -shm sidecar
  await runCase('test_mixed_engine_safety_shm_sidecar_refusal', async () => {
    const tempDir = createTempDir('egc-shm-safe-');
    const dbPath = path.join(tempDir, 'state_shm.db');
    const shmPath = `${dbPath}-shm`;

    try {
      fs.writeFileSync(dbPath, Buffer.alloc(100));
      fs.writeFileSync(shmPath, Buffer.alloc(32, 1));

      process.env.EGC_SQLITE_ENGINE = 'wasm';
      let caughtError = null;
      try {
        await openCompatDatabase(dbPath, 'wasm-shm-test');
      } catch (err) {
        caughtError = err;
      }

      assert.ok(caughtError !== null, 'Expected openCompatDatabase to throw when -shm sidecar exists');
      assert.match(
        caughtError.message,
        /shared-memory index/,
        `Expected error message mentioning shared-memory index, got: ${caughtError.message}`
      );
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  // 14. Test migration rollback correctness on statement failure
  await runCase('test_migration_rollback_on_partial_failure', async () => {
    const tempDir = createTempDir('egc-mig-rollback-');
    const dbPath = path.join(tempDir, 'state_rollback.db');

    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const db = await openCompatDatabase(dbPath, 'test-rollback');
      try {
        const { applyMigrationsAsync } = require(MIGRATIONS_PATH);

        // Bootstrap initial migrations 1-5
        await db.exec(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            adapter_id TEXT NOT NULL,
            harness TEXT NOT NULL,
            state TEXT NOT NULL,
            repo_root TEXT,
            started_at TEXT,
            ended_at TEXT,
            snapshot TEXT NOT NULL
          );
          INSERT INTO schema_migrations VALUES (1, '001_initial_state_store', datetime('now'));
          INSERT INTO schema_migrations VALUES (2, '002_instincts_and_events', datetime('now'));
          INSERT INTO schema_migrations VALUES (3, '003_lessons_confidence_decay', datetime('now'));
          INSERT INTO schema_migrations VALUES (4, '004_patterns', datetime('now'));
          INSERT INTO schema_migrations VALUES (5, '005_events_compressed_at', datetime('now'));
        `);

        // Create a faulty migration that fails on its second statement
        const faultyMigration = {
          version: 99,
          name: '099_faulty_migration',
          sql: 'ALTER TABLE sessions ADD COLUMN test_fail_col TEXT; INVALID SQL SYNTAX HERE THAT FAILS;',
        };

        const { applySingleMigrationAsync } = require(MIGRATIONS_PATH);
        let threw = false;
        try {
          await applySingleMigrationAsync(db, faultyMigration);
        } catch {
          threw = true;
        }
        assert.ok(threw, 'Expected faulty migration to throw');

        // Verify rollback occurred: test_fail_col must NOT exist and version 99 must NOT be in schema_migrations
        const versions = await db.all('SELECT version FROM schema_migrations ORDER BY version ASC;');
        assert.deepStrictEqual(
          versions.map(r => r.version),
          [1, 2, 3, 4, 5],
          'Rolled back migration version 99 must NOT be recorded in schema_migrations'
        );

        // Verify column was not committed / rolled back
        const sessionCols = await db.all("PRAGMA table_info('sessions');");
        const colNames = sessionCols.map(c => c.name);
        assert.ok(!colNames.includes('test_fail_col'), 'test_fail_col should not be present after rollback');

        // Now run standard applyMigrationsAsync to complete migration to version 6
        await applyMigrationsAsync(db);
        const finalVersions = await db.all('SELECT version FROM schema_migrations ORDER BY version ASC;');
        assert.deepStrictEqual(
          finalVersions.map(r => r.version),
          [1, 2, 3, 4, 5, 6],
          'Final schema_migrations must contain exactly versions [1, 2, 3, 4, 5, 6]'
        );
      } finally {
        await db.close();
      }
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  // 15. Regression test: SAVEPOINT rollback and trigger END must not break transaction boundaries
  await runCase('test_savepoint_and_trigger_transaction_boundaries', async () => {
    const tempDir = createTempDir('egc-tx-bounds-');
    const dbPath = path.join(tempDir, 'state_bounds.db');

    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const db = await openCompatDatabase(dbPath, 'test-bounds');
      try {
        await db.run('CREATE TABLE t_items (id TEXT PRIMARY KEY, val TEXT);');
        await db.run('CREATE TABLE t_audit (note TEXT);');

        // Test 1: CREATE TRIGGER with END inside must not be treated as COMMIT
        await db.exec(`
          CREATE TRIGGER trg_items_insert AFTER INSERT ON t_items BEGIN
            INSERT INTO t_audit VALUES ('inserted: ' || new.id);
          END;
        `);
        assert.strictEqual(db._inTransaction, false, 'CREATE TRIGGER must not open or prematurely close a transaction');

        // Test 2: Multi-statement transaction with SAVEPOINT and ROLLBACK TO SAVEPOINT
        await db.exec('BEGIN;');
        assert.strictEqual(db._inTransaction, true, 'Transaction must be active after BEGIN');

        await db.exec("INSERT INTO t_items VALUES ('a', 'initial');");
        await db.exec('SAVEPOINT sp1;');
        await db.exec("INSERT INTO t_items VALUES ('b', 'sp_val');");
        // ROLLBACK TO sp1 should rollback 'b' but must NOT terminate the outer transaction
        await db.exec('ROLLBACK TO SAVEPOINT sp1;');
        assert.strictEqual(db._inTransaction, true, 'Outer transaction must remain active after ROLLBACK TO SAVEPOINT');

        await db.exec("INSERT INTO t_items VALUES ('c', 'after_sp');");
        await db.exec('COMMIT;');
        assert.strictEqual(db._inTransaction, false, 'Transaction must be closed after COMMIT');

        // Verify committed content: 'a' and 'c' exist; 'b' was rolled back; audit trigger ran for 'a' and 'c'
        const items = await db.all('SELECT id, val FROM t_items ORDER BY id ASC;');
        assert.deepStrictEqual(items, [
          { id: 'a', val: 'initial' },
          { id: 'c', val: 'after_sp' },
        ]);

        const audits = await db.all('SELECT note FROM t_audit ORDER BY note ASC;');
        assert.deepStrictEqual(audits, [
          { note: 'inserted: a' },
          { note: 'inserted: c' },
        ]);
      } finally {
        await db.close();
      }
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  // 16. Regression test: Injected persistence failure during COMMIT restores in-memory state from disk
  await runCase('test_injected_persistence_failure_during_commit', async () => {
    const tempDir = createTempDir('egc-tx-persist-fail-');
    const dbPath = path.join(tempDir, 'state_persist_fail.db');

    try {
      process.env.EGC_SQLITE_ENGINE = 'wasm';
      const db = await openCompatDatabase(dbPath, 'test-persist-fail');
      try {
        await db.run('CREATE TABLE t_persist (id TEXT PRIMARY KEY, val TEXT);');
        await db.run("INSERT INTO t_persist VALUES ('baseline', 'ok');");

        // Verify baseline persisted
        const baselineRows = await db.all('SELECT * FROM t_persist;');
        assert.strictEqual(baselineRows.length, 1);
        assert.strictEqual(baselineRows[0].id, 'baseline');

        // Open transaction
        await db.exec('BEGIN;');
        await db.exec("INSERT INTO t_persist VALUES ('unpersisted', 'fail');");

        // Inject persistence failure into persistNow
        const originalPersistNow = db.persistNow.bind(db);
        db.persistNow = () => {
          throw new Error('Injected I/O error during transaction commit persistNow');
        };

        let threw = false;
        try {
          await db.exec('COMMIT;');
        } catch (err) {
          threw = /Injected I/i.test(err.message);
        }
        assert.ok(threw, 'Expected COMMIT to propagate persistNow failure');

        // Restore persistNow
        db.persistNow = originalPersistNow;

        // Transaction must be exited, locks released
        assert.strictEqual(db._inTransaction, false, 'Transaction must be exited after commit failure');
        assert.ok(!fs.existsSync(db.getLockPath()), 'Lock must be released');

        // Subsequent in-memory read must NOT expose the unpersisted data (it reloads from disk)
        const rowsAfterFailure = await db.all('SELECT * FROM t_persist;');
        assert.deepStrictEqual(
          rowsAfterFailure,
          [{ id: 'baseline', val: 'ok' }],
          'In-memory state must be restored from disk, not exposing unpersisted commit data'
        );
      } finally {
        await db.close();
      }
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  if (originalEnvEngine === undefined) {
    delete process.env.EGC_SQLITE_ENGINE;
  } else {
    process.env.EGC_SQLITE_ENGINE = originalEnvEngine;
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests();
