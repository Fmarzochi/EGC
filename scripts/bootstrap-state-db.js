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
        process.stderr.write('[bootstrap-state-db] WARNING: state store could not be initialized.\n');
        process.stderr.write('  The EGC state store was not created. Hook-level memory persistence is disabled.\n');
        process.stderr.write('  Run: egc init  to retry initialization.\n');
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
