'use strict';

/**
 * The memory server reads and updates the CLI state store without altering
 * its schema: the compressed_at column of events belongs to migration 005 of
 * the store, and a store that predates it falls back to observations.jsonl.
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

const { loadRawObservations, replaceObservation } = require(COMPRESS_PATH);
const { MIGRATIONS } = require('../../scripts/lib/state-store/migrations');
const { openDatabase } = require('../../scripts/lib/state-store/db-adapter');
const { createStateStore } = require('../../scripts/lib/state-store');

// The last store migration before compressed_at joined the events table.
const LAST_MIGRATION_WITHOUT_COMPRESSED_AT = 4;
const COMPRESSED_AT_MIGRATION = 5;
const JSONL_OBSERVATION = {
  id: 'jsonl-obs',
  event: 'tool_use',
  tool: 'bash',
  output: 'Error: from the jsonl fallback',
  timestamp: '2026-10-11T00:00:00.000Z',
};

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A home directory with a legacy state store (migrations 1 to 4, one session
// and one event) and the global observations.jsonl the server falls back to.
async function createLegacyFixture(prefix) {
  const dir = makeTmpDir(prefix);
  const projectRoot = path.join(dir, 'project');
  fs.mkdirSync(projectRoot);
  const dbPath = path.join(dir, 'state.db');

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

  const learningDir = path.join(dir, '.egc-learning');
  fs.mkdirSync(learningDir);
  const jsonlPath = path.join(learningDir, 'observations.jsonl');
  fs.writeFileSync(jsonlPath, `${JSON.stringify(JSONL_OBSERVATION)}\n`);

  return { dir, projectRoot, dbPath, jsonlPath, env: { EGC_STATE_DB: dbPath, HOME: dir } };
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

async function appliedVersions(dbPath) {
  const store = await createStateStore({ dbPath });
  try {
    return {
      versions: store.getAppliedMigrations().map((m) => m.version),
      columns: store._database.prepare('PRAGMA table_info(events)').all().map((c) => c.name),
    };
  } finally {
    store.close();
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

async function runTests() {
  console.log('\n=== Testing compress.js against the CLI state store ===\n');

  let passed = 0;
  let failed = 0;

  if (await test('a read of a store that predates migration 005 falls back to observations.jsonl and leaves the migration able to apply', async () => {
    const fixture = await createLegacyFixture('egc-compress-legacy-read-');
    try {
      const beforeMigration = await withEnv(fixture.env, () => loadRawObservations(fixture.projectRoot, 10));
      assert.deepStrictEqual(beforeMigration.map((o) => o.id), ['jsonl-obs'], 'an unmigrated store must be served from observations.jsonl');

      const { versions, columns } = await appliedVersions(fixture.dbPath);
      assert.ok(versions.includes(COMPRESSED_AT_MIGRATION), `migration 005 did not apply after the server read the store (applied: ${versions.join(', ')})`);
      assert.ok(columns.includes('compressed_at'), 'events has no compressed_at column after migration 005');

      const afterMigration = await withEnv(fixture.env, () => loadRawObservations(fixture.projectRoot, 10));
      assert.deepStrictEqual(afterMigration.map((o) => o.id), ['legacy-event'], 'the migrated store must serve its uncompressed events');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (await test('a replacement on a store that predates migration 005 rewrites observations.jsonl instead of failing', async () => {
    const fixture = await createLegacyFixture('egc-compress-legacy-replace-');
    try {
      const compressed = { title: 'compressed', type: 'tool_failure', facts: ['boom'], importance: 0.8, compressed_at: new Date().toISOString() };
      await withEnv(fixture.env, () => replaceObservation(fixture.projectRoot, 'jsonl-obs', compressed));

      const lines = fs.readFileSync(fixture.jsonlPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].id, 'jsonl-obs');
      assert.strictEqual(lines[0].title, 'compressed');
      assert.strictEqual(lines[0].compressed_at, compressed.compressed_at);

      const { versions } = await appliedVersions(fixture.dbPath);
      assert.ok(versions.includes(COMPRESSED_AT_MIGRATION), 'migration 005 must still apply after the server tried to update the store');
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
