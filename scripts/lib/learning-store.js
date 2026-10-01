'use strict';

const fs = require('fs');
const path = require('path');
const { getHomeDir, getKnownHarnessDirs } = require('./utils');

const LEARNING_DIR_NAME = '.egc-learning';
const LEGACY_STORE_NAME = 'homunculus';
const MIGRATION_MARKER = '.migrated-from.json';
const REGISTRY_FILE = 'projects.json';

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

// A link inside an old store could point anywhere; the store never needs one.
function isNotSymlink(entryPath) {
  try {
    return !fs.lstatSync(entryPath).isSymbolicLink();
  } catch {
    return false;
  }
}

const COPY_OPTIONS = { recursive: true, force: false, errorOnExist: false, filter: isNotSymlink };

// The first copy lands in a staging folder renamed into place, so a crash
// mid-copy never leaves a half-written store that later copies would skip.
// If another session created the store meanwhile, the copy merges into it.
function copyStore(source, storeDir) {
  if (!fs.existsSync(storeDir)) {
    const staging = `${storeDir}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.cpSync(source, staging, COPY_OPTIONS);
      fs.renameSync(staging, storeDir);
      return;
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (!fs.existsSync(storeDir)) throw error;
    }
  }
  fs.cpSync(source, storeDir, COPY_OPTIONS);
}

function readRegistry(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// The copy never overwrites, so a registry already in the store would hide
// the projects only another store knew; their keys are added, the entry
// already in the store winning.
function mergeRegistry(source, storeDir) {
  const incoming = readRegistry(path.join(source, REGISTRY_FILE));
  if (!incoming) return;
  const target = path.join(storeDir, REGISTRY_FILE);
  const current = readRegistry(target) || {};
  if (Object.keys(incoming).every(key => key in current)) return;
  fs.writeFileSync(target, JSON.stringify({ ...incoming, ...current }, null, 2));
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
      copyStore(source, storeDir);
      mergeRegistry(source, storeDir);
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
