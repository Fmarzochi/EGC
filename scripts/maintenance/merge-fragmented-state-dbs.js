'use strict';

// Manual, one-off maintenance tool (BUG-08 follow-up): additively merges rows
// from fragmented per-harness state.db files into the canonical
// ~/.egc/egc/state.db. Not wired into the egc CLI (scripts/egc.js COMMANDS) --
// this is not a user-facing feature, it is a local data-repair operation.
//
// Guarantees:
//   - Never UPDATEs or DELETEs anything, in source or destination.
//   - Source files are opened read-only: only .prepare(sql).all()/.get() are
//     ever called on them, never .exec()/.run()/.transaction(), so
//     db-adapter's debounced persist path is never triggered for a source.
//   - schema_migrations is never merged: each db file tracks its own
//     migration history, copying those rows would be meaningless.
//   - Dry-run by default; pass --apply to actually write.
//   - After a successful --apply each merged source is renamed next to itself
//     (state.db.merged-<timestamp>.bak, sidecar -wal/-shm/-journal files along
//     with it) so egc doctor stops listing it as a stray copy (#1390). Nothing
//     is ever deleted; --keep-sources leaves the files where they are.
//
// CLI usage:
//   node merge-fragmented-state-dbs.js --canonical <path> --source <path> [--source <path> ...] [--apply] [--keep-sources]

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../lib/state-store/db-adapter');
const { applyMigrations } = require('../lib/state-store/migrations');
const { resolveStateStorePath } = require('../lib/state-store');

const MERGE_TABLES = [
  { name: 'sessions', pk: ['id'] },
  { name: 'skill_runs', pk: ['id'] },
  { name: 'skill_versions', pk: ['skill_id', 'version'] },
  { name: 'decisions', pk: ['id'] },
  { name: 'install_state', pk: ['target_id', 'target_root'] },
  { name: 'governance_events', pk: ['id'] },
  { name: 'instincts', pk: ['id'] },
  { name: 'events', pk: ['id'] },
  { name: 'lessons', pk: ['id'] },
  { name: 'patterns', pk: ['id'] },
];

function tableExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get([name]);
}

function getColumns(db, name) {
  return db.prepare(`PRAGMA table_info("${name}")`).all().map(r => r.name);
}

function pickPk(row, pk) {
  const out = {};
  for (const k of pk) out[k] = row[k];
  return out;
}

function quoteColumns(cols) {
  return cols.map(c => `"${c}"`).join(', ');
}

function buildPkWhereClause(pk) {
  const conditions = pk.map(k => `"${k}" = @${k}`);
  return conditions.join(' AND ');
}

function buildNamedPlaceholders(cols) {
  const placeholders = cols.map(c => `@${c}`);
  return placeholders.join(', ');
}

function mergeOneTable(canonicalDb, srcDb, name, pk, apply) {
  if (!tableExists(srcDb, name) || !tableExists(canonicalDb, name)) {
    return { skipped: 'table missing in source or canonical' };
  }

  const srcCols = getColumns(srcDb, name);
  const dstCols = getColumns(canonicalDb, name);
  const commonCols = srcCols.filter(c => dstCols.includes(c));
  const missingPk = pk.filter(k => !commonCols.includes(k));
  if (missingPk.length > 0) {
    return { skipped: `primary key column(s) missing: ${missingPk.join(', ')}` };
  }

  const colList = quoteColumns(commonCols);
  const rows = srcDb.prepare(`SELECT ${colList} FROM "${name}"`).all();
  const whereClause = buildPkWhereClause(pk);
  const placeholders = buildNamedPlaceholders(commonCols);
  const existsStmt = canonicalDb.prepare(`SELECT 1 FROM "${name}" WHERE ${whereClause}`);
  const insertStmt = canonicalDb.prepare(`INSERT INTO "${name}" (${colList}) VALUES (${placeholders})`);

  let count = 0;
  let alreadyPresent = 0;
  for (const row of rows) {
    if (existsStmt.get(pickPk(row, pk))) {
      alreadyPresent++;
      continue;
    }
    if (apply) insertStmt.run(row);
    count++;
  }

  return {
    rowsInSource: rows.length,
    alreadyPresent,
    [apply ? 'inserted' : 'wouldInsert']: count,
    columnsCopied: commonCols,
    columnsDroppedFromSource: srcCols.filter(c => !dstCols.includes(c)),
  };
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

async function mergeOneSource(canonicalDb, srcPath, apply, canonicalPath) {
  const srcReport = { source: srcPath, tables: {} };

  if (!fs.existsSync(srcPath)) {
    srcReport.error = 'file not found';
    return srcReport;
  }
  if (canonicalPath !== ':memory:' && samePath(srcPath, canonicalPath)) {
    // Merging the store into itself is a no-op, and archiving it afterwards
    // would take the live store away.
    srcReport.error = 'source is the canonical store';
    return srcReport;
  }

  const srcDb = await openDatabase(srcPath);
  for (const { name, pk } of MERGE_TABLES) {
    srcReport.tables[name] = mergeOneTable(canonicalDb, srcDb, name, pk, apply);
  }

  return srcReport;
}

function fileStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupBeforeApply(canonicalPath) {
  if (canonicalPath === ':memory:' || !fs.existsSync(canonicalPath)) return null;
  const backupPath = `${canonicalPath}.backup-${fileStamp()}`;
  fs.copyFileSync(canonicalPath, backupPath);
  return backupPath;
}

// SQLite may leave a write-ahead log or a rollback journal next to a store;
// they belong to the file they sit beside, so they move with it.
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'];

function archiveOneSource(srcPath, stamp) {
  const archivedTo = `${srcPath}.merged-${stamp}.bak`;
  fs.renameSync(srcPath, archivedTo);
  for (const suffix of SIDECAR_SUFFIXES) {
    if (fs.existsSync(`${srcPath}${suffix}`)) fs.renameSync(`${srcPath}${suffix}`, `${archivedTo}${suffix}`);
  }
  return archivedTo;
}

// Only after the canonical store is written, flushed and closed: a source
// that failed to merge stays where it is, and a rename that fails (a file
// held open by another process on Windows) is reported, not thrown, since
// the merge itself already succeeded.
function archiveSources(reports) {
  const stamp = fileStamp();
  const archived = [];
  for (const report of reports) {
    if (report.error) continue;
    try {
      const archivedTo = archiveOneSource(report.source, stamp);
      report.archivedTo = archivedTo;
      archived.push({ source: report.source, archivedTo });
    } catch (err) {
      report.archiveError = String(err?.message ?? err);
    }
  }
  return archived;
}

async function mergeStateDbs({ canonicalPath, sourcePaths, apply = false, keepSources = false }) {
  const resolvedCanonicalPath = canonicalPath || resolveStateStorePath();
  const backupPath = apply ? backupBeforeApply(resolvedCanonicalPath) : null;

  const canonicalDb = await openDatabase(resolvedCanonicalPath);
  canonicalDb.pragma('foreign_keys = ON');
  applyMigrations(canonicalDb); // idempotent, additive-only (CREATE TABLE IF NOT EXISTS / ALTER ADD COLUMN)

  const reports = [];
  const commit = canonicalDb.transaction(() => {});
  for (const src of sourcePaths) reports.push(await mergeOneSource(canonicalDb, src, apply, resolvedCanonicalPath));
  if (apply) commit(); // no-op body; forces a single persist after all inserts above

  if (apply) await canonicalDb.flush();
  canonicalDb.close();

  const archived = apply && !keepSources ? archiveSources(reports) : [];
  return { apply, canonical: resolvedCanonicalPath, backupPath, keepSources, archived, reports };
}

function parseArgs(argv) {
  const out = { sourcePaths: [], apply: false, canonicalPath: null, keepSources: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--canonical') out.canonicalPath = argv[++i];
    else if (a === '--source') out.sourcePaths.push(argv[++i]);
    else if (a === '--apply') out.apply = true;
    else if (a === '--keep-sources') out.keepSources = true;
  }
  return out;
}

async function main() {
  const { canonicalPath, sourcePaths, apply, keepSources } = parseArgs(process.argv.slice(2));
  if (sourcePaths.length === 0) {
    console.error('Usage: node merge-fragmented-state-dbs.js [--canonical <path>] --source <path> [--source <path> ...] [--apply] [--keep-sources]');
    console.error('  After --apply each merged source is renamed to <source>.merged-<timestamp>.bak next to itself; --keep-sources leaves it in place.');
    console.error('  --canonical defaults to the real resolveStateStorePath() (~/.egc/egc/state.db) when omitted.');
    process.exitCode = 1;
    return;
  }
  const result = await mergeStateDbs({ canonicalPath, sourcePaths, apply, keepSources });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { mergeStateDbs, MERGE_TABLES };
