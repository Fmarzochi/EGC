'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getHomeDir, getKnownHarnessDirs } = require('./utils');

const LEARNING_DIR_NAME = '.egc-learning';
const LEGACY_STORE_NAME = 'homunculus';
const MIGRATION_MARKER = '.migrated-from.json';
const REGISTRY_FILE = 'projects.json';

// Written by the observer process that is actively running out of a legacy
// store. Copying a live one into the new store would make session start
// think an observer is already running there and never spawn a fresh one,
// so the running process keeps writing instincts to the old location
// instead (see scripts/lib/observer-sessions.js and observe.sh).
const OBSERVER_RUNTIME_ENTRIES = new Set([
  '.observer.pid',
  '.observer-signal-counter',
  '.observer-last-activity',
  '.observer-sessions',
]);

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

// A link inside an old store could point anywhere; the store never needs
// one. Only a confirmed symlink (or an entry that vanished, ENOENT) is
// excluded: any other lstat failure is a real problem the caller must see,
// not a file silently dropped from the migration.
function shouldCopyEntry(entryPath) {
  if (OBSERVER_RUNTIME_ENTRIES.has(path.basename(entryPath))) return false;
  try {
    return !fs.lstatSync(entryPath).isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

const COPY_OPTIONS = { recursive: true, force: false, errorOnExist: false, filter: shouldCopyEntry };

// EEXIST also answers for a dangling link or a folder at the destination;
// only a regular file there is something another writer placed, so anything
// else fails the source and keeps the marker from being written.
function assertPlacedFile(entryPath) {
  if (!fs.lstatSync(entryPath).isFile()) {
    throw new Error(`refusing to count ${entryPath} as copied: it is not a regular file`);
  }
}

// A file is placed with a hard link, which fails with EEXIST instead of
// replacing a destination that is already there, and is atomic on its own.
// A filesystem that refuses hard links (FAT, exFAT, some network shares)
// gets an exclusive copy instead, which never replaces a destination either.
function placeFile(fromPath, toPath) {
  try {
    fs.linkSync(fromPath, toPath);
    return;
  } catch (error) {
    if (error.code === 'EEXIST') {
      assertPlacedFile(toPath);
      return;
    }
  }
  try {
    fs.copyFileSync(fromPath, toPath, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assertPlacedFile(toPath);
  }
}

// Places every entry of a fully-populated staging copy into the live store,
// one at a time: an entry the store already holds (an earlier source, or
// another session that got there first) always wins, with no window between
// a check and the write where a rename would clobber it, and a crash
// mid-merge leaves only entries still in staging. A destination directory
// that is a link is refused, the store root included: following it would
// place files outside the store.
function moveNewEntries(stagingDir, storeDir) {
  if (isSymlink(storeDir)) throw new Error(`refusing to write through the link at ${storeDir}`);
  for (const entry of fs.readdirSync(stagingDir, { withFileTypes: true })) {
    const fromPath = path.join(stagingDir, entry.name);
    const toPath = path.join(storeDir, entry.name);
    if (entry.isDirectory()) {
      if (isSymlink(toPath)) throw new Error(`refusing to write through the link at ${toPath}`);
      fs.mkdirSync(toPath, { recursive: true });
      moveNewEntries(fromPath, toPath);
    } else {
      placeFile(fromPath, toPath);
    }
  }
}

function copyStore(source, storeDir) {
  fs.mkdirSync(storeDir, { recursive: true });
  const staging = `${storeDir}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.cpSync(source, staging, COPY_OPTIONS);
    moveNewEntries(staging, storeDir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function readRegistry(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function isSymlink(entryPath) {
  try {
    return fs.lstatSync(entryPath).isSymbolicLink();
  } catch {
    return false;
  }
}

// The copy never overwrites, so a registry already in the store would hide
// the projects only another store knew; their keys are added, the entry
// already in the store winning. A linked registry is skipped the same way
// the rest of the store skips links: it could point anywhere.
function mergeRegistry(source, storeDir) {
  const registryPath = path.join(source, REGISTRY_FILE);
  if (isSymlink(registryPath)) return;
  const incoming = readRegistry(registryPath);
  if (!incoming) return;
  const target = path.join(storeDir, REGISTRY_FILE);
  const current = readRegistry(target) || {};
  if (Object.keys(incoming).every(key => key in current)) return;
  fs.writeFileSync(target, JSON.stringify({ ...incoming, ...current }, null, 2));
}

// Where earlier versions kept the store, in the order they are merged:
// ~/.gemini first (the shell hooks and instinct-cli.py always wrote there),
// then each tool folder the Node hooks resolved, then ~/.egc, then EGC_DIR
// when set (getEGCDir() put the old store there before this one existed).
function legacyStoreDirs(homeDir) {
  const toolDirs = [
    path.join(homeDir, '.gemini'),
    ...getKnownHarnessDirs(homeDir),
    path.join(homeDir, '.egc'),
  ];
  if (process.env.EGC_DIR) toolDirs.push(process.env.EGC_DIR);
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
