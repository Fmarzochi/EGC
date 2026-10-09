'use strict';

const path = require('node:path');

const {
  createFlatFileOperations,
  createFlatRuleOperations,
  isForeignPlatformPath,
  normalizeRelativePath,
  planFlatSkillOperation,
  resolveModulesPlan,
} = require('./install-targets/helpers');

// Shared by auggie-home.js and auggie-project.js: Auggie reads skills,
// commands and rules the same way at both scopes, only the root differs.
// See auggie-home.js for the native-format citations (docs.augmentcode.com/cli).
function planAuggieModuleOperations(adapter, moduleId, sourceRelativePath, planningInput, targetRoot) {
  const normalized = normalizeRelativePath(sourceRelativePath);
  if (normalized === 'rules') {
    return createFlatRuleOperations({
      moduleId,
      repoRoot: planningInput.repoRoot,
      sourceRelativePath,
      destinationDir: path.join(targetRoot, 'rules'),
    });
  }
  if (normalized === 'commands') {
    return createFlatFileOperations({
      moduleId,
      repoRoot: planningInput.repoRoot,
      sourceRelativePath,
      destinationDir: path.join(targetRoot, 'commands'),
    });
  }
  return [planFlatSkillOperation(adapter, moduleId, sourceRelativePath, planningInput, targetRoot)];
}

// planOperations body shared verbatim by auggie-home.js and auggie-project.js:
// only the adapter config around it (rootSegments, kind, ...) differs.
function planAuggieOperations(input, adapter) {
  const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
  return modules.flatMap(module => {
    const paths = Array.isArray(module.paths) ? module.paths : [];
    return paths
      .filter(p => !isForeignPlatformPath(p, adapter.target))
      .flatMap(sourceRelativePath => planAuggieModuleOperations(adapter, module.id, sourceRelativePath, planningInput, targetRoot));
  });
}

module.exports = { planAuggieModuleOperations, planAuggieOperations };
