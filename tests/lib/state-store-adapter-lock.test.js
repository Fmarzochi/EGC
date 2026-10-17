'use strict';

// The CLI state store (createStateStore over db-adapter.js) shares one
// database file with the hook writer and the MCP servers, which write
// through sqlite-compat.js under the <db>.db-lock protocol. These cases
// prove the adapter writes under the same lock: no lost update between CLI
// processes, none between a CLI process and a portable hook writer, a read
// that sees what another process committed, a write that fails closed while
// a live process holds the lock, and no lock left behind by a process that
// exits without close().

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { createStateStore } = require('../../scripts/lib/state-store');

const STATE_STORE_PATH = path.resolve(__dirname, '../../scripts/lib/state-store/index.js');
const HOOK_WRITER_PATH = path.resolve(__dirname, '../../scripts/hooks/state-db-writer.js');
const PROJECT_ID = 'egc-adapter-lock-suite';

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

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-adapter-lock-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function instinct(tag, index) {
  return {
    id: `${tag}-${index}-${crypto.randomUUID()}`,
    projectId: PROJECT_ID,
    trigger: 'PostToolUse:Edit',
    content: `${tag}-write-${index}`,
    confidence: 0.5,
    createdAt: '2026-10-16T00:00:00.000Z',
  };
}

function runChild(args, { env = {}, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    if (stdin !== null) child.stdin.end(stdin);
  });
}

// A child process that opens the CLI store, writes `count` instincts and
// closes it, or exits without close() when `exitWithoutClose` is set.
function cliWriterScript({ dbPath, tag, count, exitWithoutClose = false }) {
  return `
    const { createStateStore } = require(${JSON.stringify(STATE_STORE_PATH)});
    const crypto = require('crypto');
    (async () => {
      const store = await createStateStore({ dbPath: ${JSON.stringify(dbPath)} });
      for (let i = 0; i < ${count}; i += 1) {
        store.upsertInstinct({
          id: ${JSON.stringify(tag)} + '-' + i + '-' + crypto.randomUUID(),
          projectId: ${JSON.stringify(PROJECT_ID)},
          trigger: 'PostToolUse:Edit',
          content: ${JSON.stringify(tag)} + '-write-' + i,
          confidence: 0.5,
          createdAt: '2026-10-16T00:00:00.000Z',
        });
      }
      ${exitWithoutClose ? 'process.exit(0);' : 'store.close();'}
    })().catch(err => { console.error(err); process.exit(1); });
  `;
}

async function bootstrap(dbPath) {
  const store = await createStateStore({ dbPath });
  await store.flush();
  store.close();
}

async function countInstincts(dbPath) {
  const store = await createStateStore({ dbPath });
  try {
    return store.listInstincts({ projectId: PROJECT_ID, limit: 1000 }).totalCount;
  } finally {
    store.close();
  }
}

function assertAllExited(results, label) {
  for (const [index, result] of results.entries()) {
    assert.strictEqual(result.code, 0, `${label} ${index} exited with ${result.code}: ${result.stderr}`);
  }
}

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => child.on('close', resolve));
  return child.pid;
}

function lockPayload(pid) {
  return JSON.stringify({ token: 'held-elsewhere', pid, acquiredAt: Date.now(), hostname: os.hostname() });
}

async function runTests() {
  console.log('\n=== Testing the CLI state store under the shared write lock ===\n');
  let passed = 0;
  let failed = 0;
  const run = async (name, fn) => {
    if (await test(name, fn)) passed++; else failed++;
  };

  await run('ten CLI stores writing at once from separate processes lose no row', async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, 'state.db');
    try {
      await bootstrap(dbPath);
      const WORKERS = 10;
      const results = await Promise.all(Array.from({ length: WORKERS }, (_, i) =>
        runChild(['-e', cliWriterScript({ dbPath, tag: `cli-${i}`, count: 2 })])));
      assertAllExited(results, 'CLI writer');
      assert.strictEqual(await countInstincts(dbPath), WORKERS * 2, 'every row of every process must be on disk');
      assert.ok(!fs.existsSync(`${dbPath}.db-lock`), 'no lock file may remain after the writers closed');
    } finally {
      cleanupTempDir(dir);
    }
  });

  await run('CLI stores and portable hook writers share the lock and lose no row', async () => {
    const dir = createTempDir();
    const egcDir = path.join(dir, 'egc');
    fs.mkdirSync(egcDir, { recursive: true });
    const dbPath = path.join(egcDir, 'state.db');
    try {
      await bootstrap(dbPath);
      const WORKERS = 5;
      const env = { EGC_DIR: dir, EGC_SQLITE_ENGINE: 'wasm' };
      const hooks = Array.from({ length: WORKERS }, (_, i) => runChild([HOOK_WRITER_PATH], {
        env,
        stdin: JSON.stringify({ session_id: `hook-${i}`, event_type: `tool_use_${i}`, hook_event_name: 'test_hook', payload: { i } }),
      }));
      const clis = Array.from({ length: WORKERS }, (_, i) =>
        runChild(['-e', cliWriterScript({ dbPath, tag: `cli-${i}`, count: 1 })], { env }));
      const results = await Promise.all([...hooks, ...clis]);
      assertAllExited(results, 'writer');
      for (const [index, result] of results.slice(0, WORKERS).entries()) {
        assert.strictEqual(result.stderr.trim(), '', `hook writer ${index} reported an error: ${result.stderr}`);
      }
      const store = await createStateStore({ dbPath });
      try {
        assert.strictEqual(store.listInstincts({ projectId: PROJECT_ID, limit: 100 }).totalCount, WORKERS, 'every CLI row must be on disk');
        assert.strictEqual(store._database.prepare('SELECT COUNT(*) AS n FROM events').get().n, WORKERS, 'every hook event must be on disk');
        assert.strictEqual(store._database.pragma('integrity_check')[0].integrity_check, 'ok');
      } finally {
        store.close();
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  await run('a hook writer that starts while the store file is mid-rename waits for it instead of taking the store for absent', async () => {
    const dir = createTempDir();
    const egcDir = path.join(dir, 'egc');
    fs.mkdirSync(egcDir, { recursive: true });
    const dbPath = path.join(egcDir, 'state.db');
    const held = path.join(egcDir, 'state.db.held');
    const lockPath = `${dbPath}.db-lock`;
    try {
      await bootstrap(dbPath);
      // Another writer holds the lock and has the file off its name for an
      // instant, as a rename over it does on Windows.
      fs.renameSync(dbPath, held);
      fs.writeFileSync(lockPath, lockPayload(process.pid));
      const writer = runChild([HOOK_WRITER_PATH], {
        env: { EGC_DIR: dir, EGC_SQLITE_ENGINE: 'wasm' },
        stdin: JSON.stringify({ session_id: 'late-start', event_type: 'tool_use', hook_event_name: 'test_hook', payload: {} }),
      });
      await new Promise(resolve => setTimeout(resolve, 150));
      fs.renameSync(held, dbPath);
      fs.unlinkSync(lockPath);
      const result = await writer;
      assertAllExited([result], 'hook writer');
      assert.strictEqual(result.stderr.trim(), '', `the writer reported an error: ${result.stderr}`);
      const store = await createStateStore({ dbPath });
      try {
        assert.strictEqual(store._database.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = 'late-start'").get().n, 1, 'the event must be on disk once the file is back');
      } finally {
        store.close();
      }
      fs.unlinkSync(dbPath);
      const absent = await runChild([HOOK_WRITER_PATH], {
        env: { EGC_DIR: dir, EGC_SQLITE_ENGINE: 'wasm' },
        stdin: JSON.stringify({ session_id: 'no-store', event_type: 'tool_use', hook_event_name: 'test_hook', payload: {} }),
      });
      assertAllExited([absent], 'hook writer');
      assert.ok(!fs.existsSync(dbPath), 'with no lock sidecar a missing store is still left alone');
    } finally {
      cleanupTempDir(dir);
    }
  });

  await run('an open store sees the row another process committed after it opened', async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, 'state.db');
    try {
      const store = await createStateStore({ dbPath });
      try {
        await store.flush();
        assert.strictEqual(store.listInstincts({ projectId: PROJECT_ID, limit: 10 }).totalCount, 0);
        assertAllExited([await runChild(['-e', cliWriterScript({ dbPath, tag: 'other', count: 1 })])], 'CLI writer');
        assert.strictEqual(store.listInstincts({ projectId: PROJECT_ID, limit: 10 }).totalCount, 1, 'the read must reload the file another process replaced');
        store.upsertInstinct(instinct('mine', 0));
        await store.flush();
      } finally {
        store.close();
      }
      assert.strictEqual(await countInstincts(dbPath), 2, 'the write after the reload must keep the other process row');
    } finally {
      cleanupTempDir(dir);
    }
  });

  await run('a write fails closed while another process holds the lock, dead or alive', async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, 'state.db');
    const lockPath = `${dbPath}.db-lock`;
    try {
      const store = await createStateStore({ dbPath, lockTimeoutMs: 300 });
      try {
        await store.flush();
        fs.writeFileSync(lockPath, lockPayload(process.pid));
        assert.throws(() => store.upsertInstinct(instinct('blocked', 0)), /Lock timeout after 300ms/);
        fs.writeFileSync(lockPath, lockPayload(await exitedPid()));
        assert.throws(() => store.upsertInstinct(instinct('blocked', 1)), /held by dead process/);
        fs.unlinkSync(lockPath);
        store.upsertInstinct(instinct('free', 0));
        await store.flush();
      } finally {
        store.close();
      }
      assert.strictEqual(await countInstincts(dbPath), 1, 'only the write made with the lock free may reach the file');
    } finally {
      cleanupTempDir(dir);
    }
  });

  await run('a process that exits without close() leaves its rows on disk and no lock behind', async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, 'state.db');
    try {
      await bootstrap(dbPath);
      assertAllExited([await runChild(['-e', cliWriterScript({ dbPath, tag: 'abrupt', count: 3, exitWithoutClose: true })])], 'CLI writer');
      assert.strictEqual(await countInstincts(dbPath), 3, 'the rows still debounced at exit must be written');
      assert.ok(!fs.existsSync(`${dbPath}.db-lock`), 'the lock must be released at exit');
    } finally {
      cleanupTempDir(dir);
    }
  });

  await run('a transaction that throws releases the lock and leaves the file as it was', async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, 'state.db');
    const lockPath = `${dbPath}.db-lock`;
    try {
      const store = await createStateStore({ dbPath });
      try {
        await store.flush();
        const db = store._database;
        const failing = db.transaction(() => {
          db.exec(`INSERT INTO instincts (id, project_id, trigger, content, confidence, created_at) VALUES ('tx-1', '${PROJECT_ID}', 'PostToolUse:Edit', 'rolled back', 0.5, '2026-10-16T00:00:00.000Z')`);
          throw new Error('boom');
        });
        assert.throws(() => failing(), /boom/);
        assert.ok(!fs.existsSync(lockPath), 'the lock must not outlive the failed transaction');
        assert.strictEqual(store.listInstincts({ projectId: PROJECT_ID, limit: 10 }).totalCount, 0);
      } finally {
        store.close();
      }
      assert.strictEqual(await countInstincts(dbPath), 0);
    } finally {
      cleanupTempDir(dir);
    }
  });

  await run('two stores open on the same file in one process alternate writes without losing one', async () => {
    const dir = createTempDir();
    const dbPath = path.join(dir, 'state.db');
    try {
      const first = await createStateStore({ dbPath });
      const second = await createStateStore({ dbPath });
      try {
        first.upsertInstinct(instinct('first', 0));
        second.upsertInstinct(instinct('second', 0));
        first.upsertInstinct(instinct('first', 1));
        assert.strictEqual(second.listInstincts({ projectId: PROJECT_ID, limit: 10 }).totalCount, 3, 'a read on the second store must see the first store rows');
      } finally {
        first.close();
        second.close();
      }
      assert.strictEqual(await countInstincts(dbPath), 3);
      assert.ok(!fs.existsSync(`${dbPath}.db-lock`));
    } finally {
      cleanupTempDir(dir);
    }
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  return failed;
}

runTests().then(failed => {
  process.exitCode = failed > 0 ? 1 : 0;
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
