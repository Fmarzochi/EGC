'use strict';

const { applyMigrations, getAppliedMigrations } = require('./migrations');
const { createQueryApi } = require('./queries');
const { assertValidEntity, validateEntity } = require('./schema');
const { openDatabase } = require('./db-adapter');

const { resolveStateStorePath } = require('./path');

async function createStateStore(options = {}) {
  const dbPath = resolveStateStorePath(options);

  const db = await openDatabase(dbPath);
  let queryApi, appliedMigrations;
  try {
    db.pragma('foreign_keys = ON');
    appliedMigrations = applyMigrations(db);
    queryApi = createQueryApi(db);
  } catch (err) {
    db.close();
    throw err;
  }

  return {
    dbPath,
    close() {
      db.close();
    },
    // Force any debounced write to disk now instead of waiting for the next
    // write burst or close(). Unlike close(), this surfaces persist failures
    // to the caller instead of swallowing them.
    async flush() {
      if (db.flush) await db.flush();
    },
    getAppliedMigrations() {
      return getAppliedMigrations(db);
    },
    validateEntity,
    assertValidEntity,
    ...queryApi,
    _database: db,
    _migrations: appliedMigrations,
  };
}

module.exports = {
  createStateStore,
  resolveStateStorePath,
};
