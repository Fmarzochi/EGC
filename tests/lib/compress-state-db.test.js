'use strict';

/**
 * The memory server reads the CLI state store without altering its schema:
 * the compressed_at column of events belongs to migration 005 of the store.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '../../mcp/servers/egc-memory');
const COMPRESS_PATH = path.join(SERVER_ROOT, 'build', 'compress.js');

if (!fs.existsSync(COMPRESS_PATH)) {
  console.log(`[SKIP] ${COMPRESS_PATH} not found. Run 'npm run build' in mcp/servers/egc-memory first.`);
  process.exit(0);
}

const { loadRawObservations } = require(COMPRESS_PATH);
const { MIGRATIONS } = require('../../scripts/lib/state-store/migrations');
const { openDatabase } = require('../../scripts/lib/state-store/db-adapter');
const { createStateStore } = require('../../scripts/lib/state-store');

// The last store migration before compressed_at joined the events table.
const LAST_MIGRATION_WITHOUT_COMPRESSED_AT = 4;
const COMPRESSED_AT_MIGRATION = 5;

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function createLegacyStore(dbPath, projectRoot) {
  const db = await openDatabase(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);');
  const now = new Date().toISOString();
  for (const migration of MIGRATIONS.filter((m) => m.version <= LAST_MIGRATION_WITHOUT_COMPRESSED_AT)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run([migration.version, migration.name, now]);
  }
  db.prepare('INSERT INTO sessions (id, adapter_id, harness, state, repo_root, started_at, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(['legacy-session', 'test', 'egc', 'active', projectRoot, now, '{}']);
  db.prepare('INSERT INTO events (id, session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?, ?)')
    .run(['legacy-event', 'legacy-session', 'tool_use', JSON.stringify({ tool: 'bash', output: 'Error: boom' }), now]);
  db.close();
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
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
  console.log('\n=== Testing compress.js against the CLI state store ===\n');

  let passed = 0;
  let failed = 0;

  if (await test('a read of a store that predates migration 005 leaves that migration able to apply', async () => {
    const dir = makeTmpDir('egc-compress-legacy-store-');
    const projectRoot = path.join(dir, 'project');
    fs.mkdirSync(projectRoot);
    const dbPath = path.join(dir, 'state.db');
    await createLegacyStore(dbPath, projectRoot);

    const beforeMigration = await withEnv({ EGC_STATE_DB: dbPath, HOME: dir }, () => loadRawObservations(projectRoot, 10));
    assert.deepStrictEqual(beforeMigration, [], 'a store without the column yields no observations until the CLI migrates it');

    const store = await createStateStore({ dbPath });
    try {
      const versions = store.getAppliedMigrations().map((m) => m.version);
      assert.ok(versions.includes(COMPRESSED_AT_MIGRATION), `migration 005 did not apply after the server read the store (applied: ${versions.join(', ')})`);
      const columns = store._database.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
      assert.ok(columns.includes('compressed_at'), 'events has no compressed_at column after migration 005');
    } finally {
      store.close();
    }

    const afterMigration = await withEnv({ EGC_STATE_DB: dbPath, HOME: dir }, () => loadRawObservations(projectRoot, 10));
    assert.deepStrictEqual(afterMigration.map((o) => o.id), ['legacy-event'], 'the migrated store must serve its uncompressed events');
  })) passed++; else failed++;

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
