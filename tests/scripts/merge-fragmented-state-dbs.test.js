'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mergeStateDbs } = require('../../scripts/maintenance/merge-fragmented-state-dbs');
const { openDatabase } = require('../../scripts/lib/state-store/db-adapter');
const { applyMigrations } = require('../../scripts/lib/state-store/migrations');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

async function seedDb(dbPath, { skipLessons = false } = {}) {
  const db = await openDatabase(dbPath);
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  if (skipLessons) {
    // Simulate an older fragment created before the lessons migration existed:
    // the merge logic only cares whether the table exists, so dropping it
    // here reproduces that shape closely enough for this test.
    db.exec('DROP TABLE lessons');
  }
  await db.flush();
  db.close();
}

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  ✓ ${name}`);
        return true;
      }).catch(err => {
        console.log(`  ✗ ${name}`);
        console.log(`    Error: ${err.stack || err.message}`);
        return false;
      });
    }
    console.log(`  ✓ ${name}`);
    return Promise.resolve(true);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.stack || err.message}`);
    return Promise.resolve(false);
  }
}

async function runTests() {
  console.log('\n=== Testing scripts/maintenance/merge-fragmented-state-dbs.js ===\n');

  let passed = 0;
  let failed = 0;

  if (await test('dry-run reports rows that would be inserted without touching the canonical db', async () => {
    const dir = createTempDir('egc-merge-dryrun-');
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      const sourcePath = path.join(dir, 'source.db');
      await seedDb(canonicalPath);
      await seedDb(sourcePath);

      const srcDb = await openDatabase(sourcePath);
      srcDb.prepare(
        `INSERT INTO instincts (id, project_id, trigger, content, confidence, created_at) VALUES (@id, @project_id, @trigger, @content, @confidence, @created_at)`
      ).run({ id: 'inst-1', project_id: 'p1', trigger: 't1', content: 'c1', confidence: 0.5, created_at: '2026-01-01T00:00:00Z' });
      await srcDb.flush();
      srcDb.close();

      const before = fs.readFileSync(canonicalPath);
      const result = await mergeStateDbs({ canonicalPath, sourcePaths: [sourcePath], apply: false });
      const after = fs.readFileSync(canonicalPath);

      assert.deepStrictEqual(before, after, 'canonical db file must be byte-identical after a dry run');
      assert.strictEqual(result.reports[0].tables.instincts.wouldInsert, 1);
      assert.strictEqual(result.reports[0].tables.instincts.alreadyPresent, 0);

      const canonicalDb = await openDatabase(canonicalPath);
      const rows = canonicalDb.prepare('SELECT * FROM instincts').all();
      assert.strictEqual(rows.length, 0, 'dry run must not actually insert anything');
      canonicalDb.close();
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('--apply inserts only the rows missing from canonical, keyed by primary key', async () => {
    const dir = createTempDir('egc-merge-apply-');
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      const sourcePath = path.join(dir, 'source.db');
      await seedDb(canonicalPath);
      await seedDb(sourcePath);

      const canonicalDb = await openDatabase(canonicalPath);
      canonicalDb.prepare(
        `INSERT INTO instincts (id, project_id, trigger, content, confidence, created_at) VALUES (@id, @project_id, @trigger, @content, @confidence, @created_at)`
      ).run({ id: 'inst-shared', project_id: 'p1', trigger: 'existing', content: 'canonical-content', confidence: 0.9, created_at: '2026-01-01T00:00:00Z' });
      await canonicalDb.flush();
      canonicalDb.close();

      const srcDb = await openDatabase(sourcePath);
      const insertInstinct = srcDb.prepare(
        `INSERT INTO instincts (id, project_id, trigger, content, confidence, created_at) VALUES (@id, @project_id, @trigger, @content, @confidence, @created_at)`
      );
      // Same PK as the canonical row, but different content -- must NOT overwrite.
      insertInstinct.run({ id: 'inst-shared', project_id: 'p1', trigger: 'from-source', content: 'source-content', confidence: 0.1, created_at: '2026-01-02T00:00:00Z' });
      // New PK -- must be added.
      insertInstinct.run({ id: 'inst-new', project_id: 'p1', trigger: 'new', content: 'new-content', confidence: 0.5, created_at: '2026-01-03T00:00:00Z' });
      await srcDb.flush();
      srcDb.close();

      const result = await mergeStateDbs({ canonicalPath, sourcePaths: [sourcePath], apply: true });
      assert.strictEqual(result.reports[0].tables.instincts.inserted, 1);
      assert.strictEqual(result.reports[0].tables.instincts.alreadyPresent, 1);

      const finalDb = await openDatabase(canonicalPath);
      const rows = finalDb.prepare('SELECT * FROM instincts ORDER BY id').all();
      assert.strictEqual(rows.length, 2);
      const shared = rows.find(r => r.id === 'inst-shared');
      assert.strictEqual(shared.content, 'canonical-content', 'existing canonical row must never be overwritten');
      const fresh = rows.find(r => r.id === 'inst-new');
      assert.strictEqual(fresh.content, 'new-content');
      finalDb.close();
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('a source db missing a table (older schema) is skipped without crashing, other tables still merge', async () => {
    const dir = createTempDir('egc-merge-oldschema-');
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      const sourcePath = path.join(dir, 'source.db');
      await seedDb(canonicalPath);
      await seedDb(sourcePath, { skipLessons: true });

      const srcDb = await openDatabase(sourcePath);
      srcDb.prepare(
        `INSERT INTO patterns (id, pattern_type, key, description, last_seen, first_seen) VALUES (@id, @pattern_type, @key, @description, @last_seen, @first_seen)`
      ).run({ id: 'pat-1', pattern_type: 'pt', key: 'k', description: 'd', last_seen: '2026-01-01', first_seen: '2026-01-01' });
      await srcDb.flush();
      srcDb.close();

      const result = await mergeStateDbs({ canonicalPath, sourcePaths: [sourcePath], apply: true });
      const tables = result.reports[0].tables;
      assert.ok(tables.lessons.skipped, 'lessons must be skipped since the source has no such table');
      assert.strictEqual(tables.patterns.inserted, 1, 'patterns must still merge normally');

      const finalDb = await openDatabase(canonicalPath);
      assert.strictEqual(finalDb.prepare('SELECT COUNT(*) AS n FROM patterns').get().n, 1);
      finalDb.close();
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('a source db file is never modified on disk, even when it has rows to merge', async () => {
    const dir = createTempDir('egc-merge-readonly-');
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      const sourcePath = path.join(dir, 'source.db');
      await seedDb(canonicalPath);
      await seedDb(sourcePath);

      const srcDb = await openDatabase(sourcePath);
      srcDb.prepare(
        `INSERT INTO governance_events (id, event_type, payload, created_at) VALUES (@id, @event_type, @payload, @created_at)`
      ).run({ id: 'gov-1', event_type: 'e', payload: '{}', created_at: '2026-01-01T00:00:00Z' });
      await srcDb.flush();
      srcDb.close();

      const before = fs.readFileSync(sourcePath);
      await mergeStateDbs({ canonicalPath, sourcePaths: [sourcePath], apply: true });
      const after = fs.readFileSync(sourcePath);

      assert.deepStrictEqual(before, after, 'source db file must be byte-identical, merge is read-only on sources');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('--apply creates a timestamped backup of the canonical db before writing, dry-run does not', async () => {
    const dir = createTempDir('egc-merge-backup-');
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      const sourcePath = path.join(dir, 'source.db');
      await seedDb(canonicalPath);
      await seedDb(sourcePath);

      const dryRun = await mergeStateDbs({ canonicalPath, sourcePaths: [sourcePath], apply: false });
      assert.strictEqual(dryRun.backupPath, null, 'dry run must not create a backup');

      const applied = await mergeStateDbs({ canonicalPath, sourcePaths: [sourcePath], apply: true });
      assert.ok(applied.backupPath, 'apply must create a backup');
      assert.ok(fs.existsSync(applied.backupPath), 'backup file must actually exist on disk');
      assert.ok(applied.backupPath.startsWith(canonicalPath), 'backup path must be derived from the canonical path');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('a missing source path is reported as an error instead of throwing', async () => {
    const dir = createTempDir('egc-merge-missing-');
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      await seedDb(canonicalPath);

      const result = await mergeStateDbs({
        canonicalPath,
        sourcePaths: [path.join(dir, 'does-not-exist.db')],
        apply: true,
      });
      assert.strictEqual(result.reports[0].error, 'file not found');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
