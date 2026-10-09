'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  ANTIGRAVITY_MANUAL_RULE_FRONTMATTER_TRANSFORM,
  ANTIGRAVITY_RULE_FRONTMATTER_TRANSFORM,
} = require('./install/copy-transforms');
const { isIgnoredSourceDirectory, isIgnoredSourceFile } = require('./install-source-filters');

const AGY_RULES_SUBDIR = 'config/rules';
const MANUAL_RULE_LANGUAGES = new Set(['zh']);

function normalizeRulePath(sourceRelativePath) {
  return String(sourceRelativePath).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function isRuleSource(sourceRelativePath) {
  const normalized = normalizeRulePath(sourceRelativePath);
  return normalized === 'rules' || normalized.startsWith('rules/');
}

function ruleFileName(sourceRelativeFile) {
  const relative = normalizeRulePath(sourceRelativeFile).slice('rules/'.length);
  return path.posix.basename(relative).toLowerCase() === 'readme.md' ? null : relative.replaceAll('/', '-');
}

function ruleTransform(sourceRelativeFile) {
  return MANUAL_RULE_LANGUAGES.has(normalizeRulePath(sourceRelativeFile).split('/')[1])
    ? ANTIGRAVITY_MANUAL_RULE_FRONTMATTER_TRANSFORM
    : ANTIGRAVITY_RULE_FRONTMATTER_TRANSFORM;
}

function listRuleSourceFiles(repoRoot, sourceRelativePath) {
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
        return isIgnoredSourceDirectory(entry.name) ? [] : listRuleSourceFiles(repoRoot, child);
      }
      return entry.isFile() && !isIgnoredSourceFile(entry.name) ? [child] : [];
    });
}

function planAntigravityRuleFiles(repoRoot, sourceRelativePath) {
  return listRuleSourceFiles(repoRoot || '', normalizeRulePath(sourceRelativePath))
    .map(sourceRelativeFile => ({
      sourceRelativePath: sourceRelativeFile,
      fileName: ruleFileName(sourceRelativeFile),
      transform: ruleTransform(sourceRelativeFile),
    }))
    .filter(rule => rule.fileName);
}

module.exports = {
  AGY_RULES_SUBDIR,
  isRuleSource,
  planAntigravityRuleFiles,
};
