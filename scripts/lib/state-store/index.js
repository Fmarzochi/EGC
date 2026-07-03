'use strict';

const path = require('path');

const { applyMigrations, getAppliedMigrations } = require('./migrations');
const { createQueryApi } = require('./queries');
const { assertValidEntity, validateEntity } = require('./schema');
const { openDatabase } = require('./db-adapter');

function resolveStateStorePath(options = {}) {
  if (options.dbPath) {
    if (options.dbPath === ':memory:') {
      return options.dbPath;
    }
    return path.resolve(options.dbPath);
  }

  const { getEGCDir } = require('../utils');

  if (options.homeDir) {
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const savedEgcDir = process.env.EGC_DIR;
    try {
      process.env.HOME = options.homeDir;
      process.env.USERPROFILE = options.homeDir;
      delete process.env.EGC_DIR;
      return path.join(getEGCDir(), 'egc', 'state.db');
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      if (savedEgcDir === undefined) delete process.env.EGC_DIR;
      else process.env.EGC_DIR = savedEgcDir;
    }
  }

  return path.join(getEGCDir(), 'egc', 'state.db');
}

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
