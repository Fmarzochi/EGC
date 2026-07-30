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
//
// CLI usage:
//   node merge-fragmented-state-dbs.js --canonical <path> --source <path> [--source <path> ...] [--apply]

const fs = require('node:fs');
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

async function mergeOneSource(canonicalDb, srcPath, apply) {
  const srcReport = { source: srcPath, tables: {} };

  if (!fs.existsSync(srcPath)) {
    srcReport.error = 'file not found';
    return srcReport;
  }

  const srcDb = await openDatabase(srcPath);
  for (const { name, pk } of MERGE_TABLES) {
    srcReport.tables[name] = mergeOneTable(canonicalDb, srcDb, name, pk, apply);
  }

  return srcReport;
}

function backupBeforeApply(canonicalPath) {
  if (canonicalPath === ':memory:' || !fs.existsSync(canonicalPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${canonicalPath}.backup-${stamp}`;
  fs.copyFileSync(canonicalPath, backupPath);
  return backupPath;
}

async function mergeStateDbs({ canonicalPath, sourcePaths, apply = false }) {
  const resolvedCanonicalPath = canonicalPath || resolveStateStorePath();
  const backupPath = apply ? backupBeforeApply(resolvedCanonicalPath) : null;

  const canonicalDb = await openDatabase(resolvedCanonicalPath);
  canonicalDb.pragma('foreign_keys = ON');
  applyMigrations(canonicalDb); // idempotent, additive-only (CREATE TABLE IF NOT EXISTS / ALTER ADD COLUMN)

  const reports = [];
  const commit = canonicalDb.transaction(() => {});
  for (const src of sourcePaths) reports.push(await mergeOneSource(canonicalDb, src, apply));
  if (apply) commit(); // no-op body; forces a single persist after all inserts above

  if (apply) await canonicalDb.flush();
  canonicalDb.close();

  return { apply, canonical: resolvedCanonicalPath, backupPath, reports };
}

function parseArgs(argv) {
  const out = { sourcePaths: [], apply: false, canonicalPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--canonical') out.canonicalPath = argv[++i];
    else if (a === '--source') out.sourcePaths.push(argv[++i]);
    else if (a === '--apply') out.apply = true;
  }
  return out;
}

async function main() {
  const { canonicalPath, sourcePaths, apply } = parseArgs(process.argv.slice(2));
  if (sourcePaths.length === 0) {
    console.error('Usage: node merge-fragmented-state-dbs.js [--canonical <path>] --source <path> [--source <path> ...] [--apply]');
    console.error('  --canonical defaults to the real resolveStateStorePath() (~/.egc/egc/state.db) when omitted.');
    process.exitCode = 1;
    return;
  }
  const result = await mergeStateDbs({ canonicalPath, sourcePaths, apply });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { mergeStateDbs, MERGE_TABLES };
