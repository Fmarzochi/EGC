'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  ANTIGRAVITY_MANUAL_RULE_FRONTMATTER_TRANSFORM,
  ANTIGRAVITY_RULE_FRONTMATTER_TRANSFORM,
  plannedFileContent,
} = require('./install/copy-transforms');
const { isIgnoredSourceDirectory, isIgnoredSourceFile } = require('./install-source-filters');
const { createRemappedOperation, readInstallStateOrNull } = require('./install-targets/helpers');

const AGY_RULES_SUBDIR = 'config/rules';
const MANUAL_RULE_LANGUAGES = new Set(['zh']);

function normalizeSourcePath(sourceRelativePath) {
  return String(sourceRelativePath).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function isRuleSource(sourceRelativePath) {
  const normalized = normalizeSourcePath(sourceRelativePath);
  return normalized === 'rules' || normalized.startsWith('rules/');
}

function ruleFileName(sourceRelativeFile) {
  const relative = normalizeSourcePath(sourceRelativeFile).slice('rules/'.length);
  return path.posix.basename(relative).toLowerCase() === 'readme.md' ? null : relative.replaceAll('/', '-');
}

function ruleTransform(sourceRelativeFile) {
  return MANUAL_RULE_LANGUAGES.has(normalizeSourcePath(sourceRelativeFile).split('/')[1])
    ? ANTIGRAVITY_MANUAL_RULE_FRONTMATTER_TRANSFORM
    : ANTIGRAVITY_RULE_FRONTMATTER_TRANSFORM;
}

function listSourceFiles(repoRoot, sourceRelativePath) {
  const stat = fs.statSync(path.join(repoRoot, sourceRelativePath), { throwIfNoEntry: false });
  if (stat?.isFile()) {
    return [sourceRelativePath];
  }
  if (!stat?.isDirectory()) {
    return [];
  }
  return fs.readdirSync(path.join(repoRoot, sourceRelativePath), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const child = `${sourceRelativePath}/${entry.name}`;
      if (entry.isDirectory()) {
        return isIgnoredSourceDirectory(entry.name) ? [] : listSourceFiles(repoRoot, child);
      }
      return entry.isFile() && !isIgnoredSourceFile(entry.name) ? [child] : [];
    });
}

function planAntigravityRuleFiles(repoRoot, sourceRelativePath) {
  if (!repoRoot) {
    return [];
  }
  return listSourceFiles(repoRoot, normalizeSourcePath(sourceRelativePath))
    .map(sourceRelativeFile => ({
      sourceRelativePath: sourceRelativeFile,
      fileName: ruleFileName(sourceRelativeFile),
      transform: ruleTransform(sourceRelativeFile),
    }))
    .filter(rule => rule.fileName);
}

function readRecordedDestinations(statePath) {
  const state = readInstallStateOrNull(statePath);
  const operations = Array.isArray(state?.operations) ? state.operations : [];
  return operations.map(operation => path.resolve(String(operation.destinationPath || '')));
}

function isPersonCopy(destinationPath, sourcePath, transform, recordedDestinations) {
  const stat = fs.lstatSync(destinationPath, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) {
    return false;
  }
  const resolved = path.resolve(destinationPath);
  if (recordedDestinations?.includes(resolved)) {
    return false;
  }
  try {
    return !fs.readFileSync(resolved).equals(plannedFileContent(sourcePath, transform));
  } catch {
    return true;
  }
}

function planAntigravityCopyOperations({ adapter, moduleId, files, destinationDir, repoRoot, recordedDestinations }) {
  return files
    .map(file => ({
      ...createRemappedOperation(adapter, moduleId, file.sourceRelativePath, path.join(destinationDir, file.fileName), { strategy: 'flatten-copy' }),
      transform: file.transform,
    }))
    .filter(operation => !isPersonCopy(
      operation.destinationPath,
      path.join(repoRoot, operation.sourceRelativePath),
      operation.transform,
      recordedDestinations
    ));
}

module.exports = {
  AGY_RULES_SUBDIR,
  isPersonCopy,
  isRuleSource,
  listSourceFiles,
  normalizeSourcePath,
  planAntigravityCopyOperations,
  planAntigravityRuleFiles,
  readRecordedDestinations,
};
