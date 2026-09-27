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

// Install-state files a local install may have left inside a source tree:
// runtime output, never copied as a source. Every adapter's state name fits
// one of these (egc-install-state.json, egc/install-state.json and the
// per-adapter egc/<name>-install-state.json of codex, goose and openhands).
const GENERATED_SOURCE_PATTERNS = [
  /(^|\/)egc-install-state\.json$/,
  /(^|\/)egc\/[\w-]*install-state\.json$/,
];

function isIgnoredSourceDirectory(directoryName) {
  return IGNORED_DIRECTORY_NAMES.has(directoryName);
}

function isIgnoredSourceFile(fileName) {
  if (IGNORED_FILE_NAMES.has(fileName)) {
    return true;
  }
  return IGNORED_FILE_SUFFIXES.some(suffix => fileName.endsWith(suffix));
}

// Files under scripts/hooks that only their host's adapter writes, to that
// host's own plugin location (Amp's plugins, Cline's PreToolUse shim,
// OpenCode's plugin), where their relative requires resolve. A copy of the
// scripts/hooks directory leaves them out: under <root>/scripts/hooks they
// could never load.
const HOST_PLACED_SOURCES = new Set([
  'scripts/hooks/amp-guardian-crusher-plugin.ts',
  'scripts/hooks/amp-mesh-notice-plugin.ts',
  'scripts/hooks/cline-pretooluse-shim.js',
  'scripts/hooks/opencode-egc-plugin.js',
]);

function isHostPlacedSourcePath(sourceRelativePath) {
  return HOST_PLACED_SOURCES.has(String(sourceRelativePath || '').replaceAll('\\', '/'));
}

function isGeneratedRuntimeSourcePath(sourceRelativePath) {
  const normalizedPath = String(sourceRelativePath || '').replaceAll('\\', '/');
  return GENERATED_SOURCE_PATTERNS.some(pattern => pattern.test(normalizedPath));
}

module.exports = {
  HOST_PLACED_SOURCES,
  isGeneratedRuntimeSourcePath,
  isHostPlacedSourcePath,
  isIgnoredSourceDirectory,
  isIgnoredSourceFile,
};
