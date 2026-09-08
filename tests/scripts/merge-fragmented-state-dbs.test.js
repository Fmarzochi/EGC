'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { execFileSync } = require('child_process');

const { mergeStateDbs, archiveOneSource } = require('../../scripts/maintenance/merge-fragmented-state-dbs');
const { openDatabase } = require('../../scripts/lib/state-store/db-adapter');
const { applyMigrations } = require('../../scripts/lib/state-store/migrations');

const DOCTOR_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'doctor.js');
const CLI_TIMEOUT_MS = process.platform === 'win32' ? 30000 : 10000;

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const MERGE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'maintenance', 'merge-fragmented-state-dbs.js');

function runMergeCli(args) {
  try {
    const stdout = execFileSync('node', [MERGE_SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function runDoctor(homeDir, cwd) {
  try {
    const stdout = execFileSync('node', [DOCTOR_SCRIPT], {
      cwd,
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS,
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '' };
  }
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
      const result = await mergeStateDbs({ canonicalPath, sourcePaths: [sourcePath], apply: true, keepSources: true });
      const after = fs.readFileSync(sourcePath);

      assert.deepStrictEqual(before, after, 'source db file must be byte-identical, merge is read-only on sources');
      assert.deepStrictEqual(result.archived, [], '--keep-sources must leave every source in place');
      assert.strictEqual(result.keepSources, true);
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

  if (await test('--apply renames each merged source to a .merged-<timestamp>.bak next to itself, sidecars included, byte for byte', async () => {
    const dir = createTempDir('egc-merge-archive-');
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      const sources = [path.join(dir, 'gemini', 'state.db'), path.join(dir, 'opencode', 'state.db')];
      await seedDb(canonicalPath);
      for (const source of sources) {
        fs.mkdirSync(path.dirname(source), { recursive: true });
        await seedDb(source);
      }
      const sidecar = `${sources[0]}-wal`;
      fs.writeFileSync(sidecar, 'wal-bytes');
      const originalBytes = sources.map(source => fs.readFileSync(source));

      const result = await mergeStateDbs({ canonicalPath, sourcePaths: sources, apply: true });

      assert.strictEqual(result.keepSources, false);
      assert.strictEqual(result.archived.length, 2, 'both merged sources must be archived');
      sources.forEach((source, index) => {
        const entry = result.archived[index];
        assert.strictEqual(entry.source, source);
        assert.strictEqual(result.reports[index].archivedTo, entry.archivedTo, 'the per-source report must carry the new name too');
        assert.ok(entry.archivedTo.startsWith(`${source}.merged-`), 'the archive must sit next to the source it replaces');
        assert.ok(entry.archivedTo.endsWith('.bak'));
        assert.ok(!fs.existsSync(source), 'the original name must be gone so the doctor stops flagging it');
        assert.deepStrictEqual(fs.readFileSync(entry.archivedTo), originalBytes[index], 'archiving is a rename: the bytes must survive untouched');
      });
      assert.ok(!fs.existsSync(sidecar), 'the write-ahead log must move with its store');
      assert.ok(fs.existsSync(`${result.archived[0].archivedTo}-wal`), 'and keep its suffix next to the archived name');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('a dry run archives nothing, and neither does a source that could not be merged', async () => {
    const dir = createTempDir('egc-merge-noarchive-');
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      const sourcePath = path.join(dir, 'source.db');
      const missingPath = path.join(dir, 'missing.db');
      await seedDb(canonicalPath);
      await seedDb(sourcePath);

      const dryRun = await mergeStateDbs({ canonicalPath, sourcePaths: [sourcePath], apply: false });
      assert.deepStrictEqual(dryRun.archived, [], 'a dry run must not rename anything');
      assert.ok(fs.existsSync(sourcePath));

      const applied = await mergeStateDbs({ canonicalPath, sourcePaths: [missingPath, sourcePath], apply: true });
      assert.strictEqual(applied.reports[0].error, 'file not found');
      assert.strictEqual(applied.reports[0].archivedTo, undefined, 'a source that failed to merge stays as it is');
      assert.strictEqual(applied.archived.length, 1, 'the source that did merge is archived');
      assert.strictEqual(applied.archived[0].source, sourcePath);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('the canonical store handed in as a source is refused and left in place', async () => {
    const dir = createTempDir('egc-merge-self-');
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      await seedDb(canonicalPath);

      const result = await mergeStateDbs({ canonicalPath, sourcePaths: [path.join(dir, '.', 'canonical.db')], apply: true });
      assert.strictEqual(result.reports[0].error, 'source is the canonical store');
      assert.deepStrictEqual(result.archived, []);
      assert.ok(fs.existsSync(canonicalPath), 'the live store must never be renamed');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('after --apply the doctor no longer lists the merged copies as stray', async () => {
    const homeDir = createTempDir('egc-merge-home-');
    const projectRoot = createTempDir('egc-merge-project-');
    try {
      const canonicalPath = path.join(homeDir, '.egc', 'egc', 'state.db');
      const memoryPath = path.join(homeDir, '.egc', 'memory', 'state.db');
      const strays = [
        path.join(homeDir, '.gemini', 'egc', 'state.db'),
        path.join(homeDir, '.config', 'opencode', 'egc', 'state.db'),
      ];
      for (const file of [canonicalPath, ...strays]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await seedDb(file);
      }
      fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
      fs.writeFileSync(memoryPath, '');

      const before = runDoctor(homeDir, projectRoot);
      assert.strictEqual(before.code, 0, before.stdout);
      assert.ok(before.stdout.includes('2 stray state.db copies'), 'the fixture must reproduce the warning first');

      const result = await mergeStateDbs({ canonicalPath, sourcePaths: strays, apply: true });
      assert.strictEqual(result.archived.length, 2);

      const after = runDoctor(homeDir, projectRoot);
      assert.strictEqual(after.code, 0, after.stdout);
      assert.ok(!after.stdout.includes('stray state.db'), `the doctor must come back clean, got:\n${after.stdout}`);
      assert.ok(fs.existsSync(canonicalPath), 'the canonical store stays');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (await test('the CLI honours --keep-sources and explains the archive step in its usage text', async () => {
    const dir = createTempDir('egc-merge-cli-');
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      const sourcePath = path.join(dir, 'source.db');
      await seedDb(canonicalPath);
      await seedDb(sourcePath);

      const usage = runMergeCli(['--canonical', canonicalPath]);
      assert.strictEqual(usage.code, 1, 'no --source must still exit with the usage text');
      assert.ok(usage.stderr.includes('--keep-sources'), 'the usage must list the new flag');
      assert.ok(usage.stderr.includes('.merged-<timestamp>.bak'), 'and say what --apply does to the sources');

      const kept = runMergeCli(['--canonical', canonicalPath, '--source', sourcePath, '--apply', '--keep-sources']);
      assert.strictEqual(kept.code, 0, kept.stderr);
      const parsed = JSON.parse(kept.stdout);
      assert.strictEqual(parsed.keepSources, true);
      assert.deepStrictEqual(parsed.archived, []);
      assert.ok(fs.existsSync(sourcePath), 'the source must stay under its own name');

      const archived = runMergeCli(['--canonical', canonicalPath, '--source', sourcePath, '--apply']);
      assert.strictEqual(archived.code, 0, archived.stderr);
      const applied = JSON.parse(archived.stdout);
      assert.strictEqual(applied.archived.length, 1);
      assert.ok(fs.existsSync(applied.archived[0].archivedTo));
      assert.ok(!fs.existsSync(sourcePath));
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('a rename that fails is reported on that source while the merge result stands', async () => {
    const dir = createTempDir('egc-merge-archive-error-');
    const originalRename = fs.renameSync;
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      const sourcePath = path.join(dir, 'source.db');
      await seedDb(canonicalPath);
      await seedDb(sourcePath);

      // The script and this test share the same fs module object, so a
      // rename that throws here is exactly what a file held open by another
      // process produces on Windows, on every platform the suite runs on.
      fs.renameSync = () => {
        const error = new Error('EBUSY: resource busy or locked');
        error.code = 'EBUSY';
        throw error;
      };
      const result = await mergeStateDbs({ canonicalPath, sourcePaths: [sourcePath], apply: true });
      fs.renameSync = originalRename;

      assert.strictEqual(result.apply, true);
      assert.ok(result.backupPath && fs.existsSync(result.backupPath), 'the canonical backup was still taken');
      assert.deepStrictEqual(result.archived, [], 'nothing was archived');
      assert.strictEqual(result.reports[0].archivedTo, undefined);
      assert.ok(result.reports[0].archiveError.includes('EBUSY'), 'the failure is reported on the source entry');
      assert.ok(fs.existsSync(sourcePath), 'the source stays under its own name');
    } finally {
      fs.renameSync = originalRename;
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('the canonical store reached through a symlink or another spelling is refused all the same', async () => {
    const dir = createTempDir('egc-merge-alias-');
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      await seedDb(canonicalPath);

      let alias;
      if (process.platform === 'win32') {
        // NTFS resolves both spellings to the same file.
        alias = path.join(dir, 'CANONICAL.DB');
      } else {
        alias = path.join(dir, 'alias.db');
        fs.symlinkSync(canonicalPath, alias);
      }

      const result = await mergeStateDbs({ canonicalPath, sourcePaths: [alias], apply: true });
      assert.strictEqual(result.reports[0].error, 'source is the canonical store');
      assert.deepStrictEqual(result.archived, []);
      assert.ok(fs.existsSync(canonicalPath), 'the live store must still be there under its own name');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('an archive destination that already exists is never overwritten', async () => {
    const dir = createTempDir('egc-merge-collision-');
    try {
      const sourcePath = path.join(dir, 'source.db');
      fs.writeFileSync(sourcePath, 'live-bytes');
      const taken = `${sourcePath}.merged-fixed.bak`;
      fs.writeFileSync(taken, 'older-archive');

      assert.throws(() => archiveOneSource(sourcePath, 'fixed'), /archive destination already exists/);
      assert.strictEqual(fs.readFileSync(taken, 'utf8'), 'older-archive', 'the earlier archive must survive');
      assert.strictEqual(fs.readFileSync(sourcePath, 'utf8'), 'live-bytes', 'and the source must not move');

      fs.renameSync(taken, `${taken}-wal`);
      fs.writeFileSync(`${sourcePath}-wal`, 'live-wal');
      assert.throws(() => archiveOneSource(sourcePath, 'fixed'), /archive destination already exists/, 'a sidecar destination counts too');
      assert.ok(fs.existsSync(sourcePath), 'nothing moves when any destination is taken');
      assert.strictEqual(fs.readFileSync(`${taken}-wal`, 'utf8'), 'older-archive');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('a sidecar that fails to move puts the store back under its original name', async () => {
    const dir = createTempDir('egc-merge-rollback-');
    const originalRename = fs.renameSync;
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      const sourcePath = path.join(dir, 'source.db');
      await seedDb(canonicalPath);
      await seedDb(sourcePath);
      const sidecar = `${sourcePath}-wal`;
      fs.writeFileSync(sidecar, 'wal-bytes');

      fs.renameSync = (from, to) => {
        if (from.endsWith('-wal')) {
          const error = new Error('EPERM: operation not permitted');
          error.code = 'EPERM';
          throw error;
        }
        return originalRename(from, to);
      };
      const result = await mergeStateDbs({ canonicalPath, sourcePaths: [sourcePath], apply: true });
      fs.renameSync = originalRename;

      assert.ok(result.reports[0].archiveError.includes('EPERM'));
      assert.deepStrictEqual(result.archived, []);
      assert.ok(fs.existsSync(sourcePath), 'the store must be rolled back to its original name');
      assert.ok(fs.existsSync(sidecar), 'the sidecar never moved');
      assert.ok(!fs.readdirSync(dir).some(name => name.includes('.merged-')), 'no half-archive may be left behind');
    } finally {
      fs.renameSync = originalRename;
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (await test('a source none of whose tables could be read stays in place and says why', async () => {
    const dir = createTempDir('egc-merge-unreadable-');
    try {
      const canonicalPath = path.join(dir, 'canonical.db');
      const sourcePath = path.join(dir, 'source.db');
      await seedDb(canonicalPath);
      // An empty SQLite file: valid database, none of the EGC tables.
      const empty = await openDatabase(sourcePath);
      empty.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
      await empty.flush();
      empty.close();

      const result = await mergeStateDbs({ canonicalPath, sourcePaths: [sourcePath], apply: true });
      assert.ok(Object.values(result.reports[0].tables).every(table => table.skipped), 'every table must have been skipped');
      assert.strictEqual(result.reports[0].archiveSkipped, 'no table could be merged from this source');
      assert.strictEqual(result.reports[0].archivedTo, undefined);
      assert.deepStrictEqual(result.archived, []);
      assert.ok(fs.existsSync(sourcePath), 'the file stays where the doctor can still see it');
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
