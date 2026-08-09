'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore, resolveStateStorePath } = require('../state-store');
const { openDatabase } = require('../state-store/db-adapter');
const { collectProjectStates } = require('../state-overview');
const { getKnownHarnessDirs } = require('../utils');

async function stateStoreQueryOperation(params = {}) {
  const store = await createStateStore({
    dbPath: params.dbPath,
    homeDir: params.homeDir,
  });
  try {
    const method = params.method || 'getStatus';
    if (typeof store[method] !== 'function') {
      throw new Error(`Invalid state_store method: ${method}`);
    }
    return await store[method](params.args || params.options);
  } finally {
    store.close();
  }
}

function findStateDbPath(options = {}) {
  if (options.dbPath) {
    return fs.existsSync(options.dbPath) ? options.dbPath : null;
  }
  const primary = resolveStateStorePath(options);
  if (fs.existsSync(primary)) return primary;

  const home = options.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const candidateDirs = [
    path.join(home, '.claude'),
    path.join(home, '.gemini'),
    path.join(home, '.egc'),
    path.join(home, '.cursor'),
    path.join(home, '.kiro'),
    ...getKnownHarnessDirs(home),
  ];

  for (const dir of candidateDirs) {
    const dbPath = path.join(dir, 'egc', 'state.db');
    if (fs.existsSync(dbPath)) return dbPath;
  }
  return null;
}

async function queryStateDbStats(options = {}) {
  const dbPath = findStateDbPath(options);
  if (!dbPath) return null;

  try {
    const db = await openDatabase(dbPath);
    try {
      const q = (sql) => {
        try {
          const row = db.prepare(sql).get();
          if (!row) return 0;
          const val = Object.values(row)[0];
          return parseInt(val, 10) || 0;
        } catch (_) {
          return 0;
        }
      };
      return {
        decisions: q('SELECT COUNT(*) FROM decisions'),
        lessons: q('SELECT COUNT(*) FROM lessons WHERE archived = 0'),
        patterns: q('SELECT COUNT(*) FROM patterns'),
      };
    } finally {
      db.close();
    }
  } catch (_) {
    return null;
  }
}

function queryStateMarkdownDecisions(options = {}) {
  try {
    const overview = collectProjectStates(options);
    return overview.entries.reduce((sum, entry) => sum + (entry.decisionCount || 0), 0);
  } catch (_) {
    return 0;
  }
}

module.exports = {
  stateStoreQueryOperation,
  queryStateDbStats,
  queryStateMarkdownDecisions,
};
