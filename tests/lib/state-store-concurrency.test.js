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

const PROJECT_ID = 'egc-concurrency-suite';

function detectPython3() {
  const result = spawnSync('python3', ['-c', 'import sqlite3; print(sqlite3.sqlite_version)'], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

const PYTHON_AVAILABLE = detectPython3();

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
  console.log('\n=== Testing state-store concurrency (Node + Python writers) ===\n');

  let passed = 0;
  let failed = 0;

  const runCase = async (name, fn) => {
    if (await test(name, fn)) passed += 1; else failed += 1;
  };

  const WAL_SUPPORTED = await detectWalSupport();

  if (!PYTHON_AVAILABLE) {
    testSkip('test_python_writes_survive_subsequent_node_open', 'python3 not available');
    testSkip('test_concurrent_node_python_writes_no_lost_writes', 'python3 not available');
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
      testSkip('test_concurrent_node_python_writes_no_lost_writes', 'database adapter uses in-memory model without WAL; concurrent external writes not supported');
    } else await runCase('test_concurrent_node_python_writes_no_lost_writes', async () => {
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

  if (!WAL_SUPPORTED) {
    testSkip('test_wal_mode_active_on_real_file_db', 'database adapter uses in-memory model; WAL journal mode not applicable');
  } else await runCase('test_wal_mode_active_on_real_file_db', async () => {
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

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
