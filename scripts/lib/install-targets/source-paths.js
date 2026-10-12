'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { isIgnoredSourceDirectory, isIgnoredSourceFile } = require('../install-source-filters');

const PLATFORM_SOURCE_PATH_OWNERS = Object.freeze({
  '.gemini-plugin': 'egc',
  '.codex': 'codex',
  '.cursor': 'cursor',
  '.gemini': 'gemini',
  '.opencode': 'opencode',
  '.codebuddy': 'codebuddy',
  '.kiro': 'kiro',
});

function normalizeRelativePath(relativePath) {
  return String(relativePath || '')
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, ''); // NOSONAR: superlinear risk accepted: input is repo-owned or local state content, never network-controlled
}

// Paths that carry a platform identity rather than library content. Every
// target that takes agents-core receives agents/; the Codex and Antigravity
// .agents tree and the root AGENTS.md each go only to the targets listed
// under their own key, so a home root such as ~/.amp or ~/.claude never
// grows either.
const IDENTITY_SOURCE_PATH_OWNERS = Object.freeze({
  '.agents': Object.freeze(['egc', 'cursor', 'antigravity', 'codex', 'codebuddy', 'zed']),
  'AGENTS.md': Object.freeze(['egc', 'cursor', 'antigravity', 'codex', 'codebuddy', 'zed', 'vibe', 'grok', 'kilo', 'mimo', 'pi', 'droid']),
});

function isForeignPlatformPath(sourceRelativePath, adapterTarget) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);

  for (const [prefix, ownerTarget] of Object.entries(PLATFORM_SOURCE_PATH_OWNERS)) {
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      return ownerTarget !== adapterTarget;
    }
  }

  for (const [prefix, owners] of Object.entries(IDENTITY_SOURCE_PATH_OWNERS)) {
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      return !owners.includes(adapterTarget);
    }
  }

  return false;
}

function listRelativeFiles(dirPath, prefix = '') {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((left, right) => (
    left.name.localeCompare(right.name)
  ));
  const files = [];

  for (const entry of entries) {
    const entryPrefix = prefix ? path.join(prefix, entry.name) : entry.name;
    const absolutePath = path.join(dirPath, entry.name);

    // Same artifact exclusions as install-executor.js's listFilesRecursive:
    // adapter plans enumerate sources through this path too, and a local
    // .DS_Store or __pycache__ must never become a managed install source.
    if (entry.isDirectory()) {
      if (isIgnoredSourceDirectory(entry.name)) {
        continue;
      }
      files.push(...listRelativeFiles(absolutePath, entryPrefix));
    } else if (entry.isFile() && !isIgnoredSourceFile(entry.name)) {
      files.push(normalizeRelativePath(entryPrefix));
    }
  }

  return files;
}

module.exports = {
  isForeignPlatformPath,
  listRelativeFiles,
  normalizeRelativePath,
};
