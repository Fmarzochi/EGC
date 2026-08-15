'use strict';
// Dependency resolution for the mesh lab. The sqlite driver is an existing
// production dependency of the repo root (and of the egc-memory server), so
// the prototype installs nothing new: it resolves the driver from wherever
// the active package manager placed it and reports null when unreachable so
// callers can SKIP instead of crashing (yarn hoists neither location).

const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const resolvePaths = [repoRoot, path.join(repoRoot, 'mcp', 'servers', 'egc-memory')];

function tryRequire(id) {
  try {
    return require(require.resolve(id, { paths: resolvePaths }));
  } catch {
    return null;
  }
}

function loadSqliteDriver() {
  const sqlite3 = tryRequire('sqlite3');
  const sqlite = tryRequire('sqlite');
  if (!sqlite3 || !sqlite) return null;
  return { sqlite3, open: sqlite.open };
}

module.exports = { loadSqliteDriver, repoRoot };
