#!/usr/bin/env node
'use strict';

const { createStateStore } = require('./lib/state-store');

async function bootstrap(options = {}) {
  const store = await createStateStore(options);
  const dbPath = store.dbPath;
  try {
    if (store.nativeUnavailable) {
      return { ok: false, nativeUnavailable: true, dbPath, migrations: [] };
    }
    return { ok: true, dbPath, migrations: store.getAppliedMigrations() };
  } finally {
    store.close();
  }
}

if (require.main === module) {
  bootstrap()
    .then(result => {
      if (!result.ok) {
        process.stderr.write('[bootstrap-state-db] WARNING: better-sqlite3 native module unavailable.\n');
        process.stderr.write('  The EGC state store was not created. Hook-level memory persistence is disabled.\n');
        process.stderr.write('  On Windows: install Visual Studio Build Tools, then run: npm rebuild better-sqlite3\n');
        process.stderr.write('  On Linux/macOS: ensure build-essential and python3 are installed, then run: npm rebuild better-sqlite3\n');
        process.exit(0);
      }
      process.stderr.write(`[bootstrap-state-db] OK ${result.dbPath} (${result.migrations.length} migrations)\n`);
      process.exit(0);
    })
    .catch(err => {
      process.stderr.write(`[bootstrap-state-db] FAILED: ${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { bootstrap };
