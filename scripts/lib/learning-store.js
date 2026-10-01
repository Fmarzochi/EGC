'use strict';

const fs = require('fs');
const path = require('path');
const { getHomeDir, getKnownHarnessDirs } = require('./utils');

const LEARNING_DIR_NAME = '.egc-learning';
const LEGACY_STORE_NAME = 'homunculus';
const MIGRATION_MARKER = '.migrated-from.json';

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

// Where earlier versions kept the store, in the order they are merged:
// ~/.gemini first (the shell hooks and instinct-cli.py always wrote there),
// then each tool folder the Node hooks resolved, then ~/.egc.
function legacyStoreDirs(homeDir) {
  const toolDirs = [
    path.join(homeDir, '.gemini'),
    ...getKnownHarnessDirs(homeDir),
    path.join(homeDir, '.egc'),
  ];
  return [...new Set(toolDirs)].map(dir => path.join(dir, LEGACY_STORE_NAME));
}

/**
 * Copies the stores of earlier versions into ~/.egc-learning once. A file
 * already in the new store is never overwritten, the old stores are never
 * modified, and a marker keeps later sessions from copying again.
 */
function migrateLegacyLearningStore({ homeDir = getHomeDir(), now = () => new Date() } = {}) {
  const storeDir = path.join(homeDir, LEARNING_DIR_NAME);
  const markerPath = path.join(storeDir, MIGRATION_MARKER);
  if (fs.existsSync(markerPath)) return { migrated: [], failed: [] };

  const sources = legacyStoreDirs(homeDir).filter(isDirectory);
  if (sources.length === 0) return { migrated: [], failed: [] };

  const migrated = [];
  const failed = [];
  for (const source of sources) {
    try {
      fs.cpSync(source, storeDir, { recursive: true, force: false, errorOnExist: false });
      migrated.push(source);
    } catch (error) {
      failed.push({ source, error: error.message });
    }
  }

  if (failed.length === 0) {
    fs.writeFileSync(markerPath, JSON.stringify({ migratedAt: now().toISOString(), sources: migrated }, null, 2));
  }
  return { migrated, failed };
}

module.exports = {
  LEARNING_DIR_NAME,
  MIGRATION_MARKER,
  legacyStoreDirs,
  migrateLegacyLearningStore,
};
