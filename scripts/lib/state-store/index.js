'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyMigrations, getAppliedMigrations } = require('./migrations');
const { createQueryApi } = require('./queries');
const { assertValidEntity, validateEntity } = require('./schema');

const DEFAULT_STATE_STORE_RELATIVE_PATH = path.join('.gemini', 'egc', 'state.db');

// Try to load better-sqlite3. On Windows without Build Tools the native
// module may not compile — in that case we fall back to a null/amnesiac
// store so the installer and CLI degrade gracefully instead of crashing.
let Database = null;
let _nativeUnavailable = false;
try {
  Database = require('better-sqlite3');
} catch (_err) {
  _nativeUnavailable = true;
}

function resolveStateStorePath(options = {}) {
  if (options.dbPath) {
    if (options.dbPath === ':memory:') {
      return options.dbPath;
    }
    return path.resolve(options.dbPath);
  }

  const homeDir = options.homeDir || process.env.HOME || os.homedir();
  return path.join(homeDir, DEFAULT_STATE_STORE_RELATIVE_PATH);
}

function sanitizeNamedParams(params) {
  if (params === null || params === undefined) {
    return params;
  }
  if (typeof params !== 'object' || Array.isArray(params)) {
    return params;
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(params)) {
    sanitized[key] = value === undefined ? null : value;
  }
  return sanitized;
}

function wrapStatement(stmt) {
  return {
    all(...args) {
      return stmt.all(...args);
    },
    get(...args) {
      const row = stmt.get(...args);
      return row === undefined ? null : row;
    },
    run(params) {
      if (params && typeof params === 'object' && !Array.isArray(params)) {
        return stmt.run(sanitizeNamedParams(params));
      }
      if (params === undefined) {
        return stmt.run();
      }
      return stmt.run(params);
    },
  };
}

function wrapDatabase(rawDb) {
  return {
    exec(sql) {
      rawDb.exec(sql);
    },
    pragma(pragmaStr) {
      return rawDb.pragma(pragmaStr);
    },
    prepare(sql) {
      return wrapStatement(rawDb.prepare(sql));
    },
    transaction(fn) {
      return rawDb.transaction(fn);
    },
    close() {
      rawDb.close();
    },
  };
}

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const rawDb = new Database(dbPath);
  rawDb.pragma('foreign_keys = ON');
  if (dbPath !== ':memory:') {
    rawDb.pragma('journal_mode = WAL');
  }
  return wrapDatabase(rawDb);
}

// Null store: implements the full createStateStore return shape with
// no-op/empty responses. Used when better-sqlite3 cannot be loaded.
function createNullQueryApi() {
  const emptyStatus = {
    generatedAt: new Date().toISOString(),
    activeSessions: { activeCount: 0, sessions: [] },
    skillRuns: { windowSize: 20, summary: { successCount: 0, failureCount: 0, unknownCount: 0, successRate: null, failureRate: null, recentRuns: [] }, recent: [] },
    installHealth: { targetCount: 0, healthyCount: 0, warningCount: 0, installations: [] },
    governance: { pendingCount: 0, events: [] },
  };
  return {
    getSessionById: () => null,
    getSessionDetail: () => null,
    getStatus: () => emptyStatus,
    insertDecision: () => {},
    insertGovernanceEvent: () => {},
    insertSkillRun: () => {},
    upsertInstallState: () => {},
    upsertSession: () => {},
    upsertSkillVersion: () => {},
    upsertInstinct: () => {},
    listInstincts: () => ({ totalCount: 0, instincts: [] }),
    insertRuntimeEvent: () => {},
    listRecentEvents: () => [],
  };
}

async function createStateStore(options = {}) {
  const dbPath = resolveStateStorePath(options);

  if (_nativeUnavailable) {
    process.stderr.write(
      '[egc-state-store] WARNING: better-sqlite3 native module unavailable.\n' +
      '  SQLite persistence is disabled. Memory features via egc-memory MCP server are unaffected.\n' +
      '  To enable full SQLite on Windows: install Visual Studio Build Tools, then re-run install.ps1\n' +
      '  See: https://github.com/Fmarzochi/everything-gemini#installation\n'
    );
    return {
      dbPath,
      close() {},
      getAppliedMigrations() { return []; },
      validateEntity,
      assertValidEntity,
      _database: null,
      _migrations: [],
      ...createNullQueryApi(),
    };
  }

  const db = openDatabase(dbPath);
  const appliedMigrations = applyMigrations(db);
  const queryApi = createQueryApi(db);

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
  DEFAULT_STATE_STORE_RELATIVE_PATH,
  createStateStore,
  resolveStateStorePath,
};
