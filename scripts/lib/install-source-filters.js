'use strict';

// Machine-generated tooling artifacts must never become managed install
// sources: they differ per machine, and npm never packs .gitignore at all,
// so an install-state entry recorded for one of these can never be satisfied
// from the published package again. Shared by every source enumerator
// (install-executor.js and the install-target helpers), so no planning path
// can reintroduce them.
const IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  '__pycache__',
]);

const IGNORED_FILE_NAMES = new Set([
  '.gitignore',
  '.DS_Store',
  'Thumbs.db',
]);

const IGNORED_FILE_SUFFIXES = ['.pyc', '.pyo'];

function isIgnoredSourceDirectory(directoryName) {
  return IGNORED_DIRECTORY_NAMES.has(directoryName);
}

function isIgnoredSourceFile(fileName) {
  if (IGNORED_FILE_NAMES.has(fileName)) {
    return true;
  }
  return IGNORED_FILE_SUFFIXES.some(suffix => fileName.endsWith(suffix));
}

module.exports = {
  isIgnoredSourceDirectory,
  isIgnoredSourceFile,
};
