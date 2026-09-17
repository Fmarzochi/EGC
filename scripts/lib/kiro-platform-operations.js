'use strict';

const path = require('node:path');

const {
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  planFlatSkillOperation,
  resolveModulesPlan,
} = require('./install-targets/helpers');

// The Kiro-native assets the retired .kiro/install.sh used to copy: agents
// in Kiro's own JSON and Markdown shape, steering documents, IDE hooks,
// helper scripts and the MCP settings example. They ship with platform-configs
// from the repository's .kiro directory and land under the same names at the
// Kiro root, home or project. The README, the docs and the hand-curated
// skills of that directory stay out: skills ship through the catalog modules.
const KIRO_PLATFORM_DIRS = Object.freeze(['agents', 'steering', 'hooks', 'scripts', 'settings']);

// platform-configs also names files other targets keep on their own roots.
const KIRO_EXCLUDED_SOURCE_PREFIXES = Object.freeze(['mcp-configs', 'scripts/auto-update.js', 'scripts/setup-package-manager.js']);

function isKiroExcludedPath(sourceRelativePath) {
  const normalized = normalizeRelativePath(sourceRelativePath);
  return KIRO_EXCLUDED_SOURCE_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function planKiroPlatformOperations(adapter, moduleId, sourceRelativePath, targetRoot) {
  const normalized = normalizeRelativePath(sourceRelativePath);
  if (normalized === '.kiro') {
    return KIRO_PLATFORM_DIRS.map(dir => createRemappedOperation(
      adapter,
      moduleId,
      `.kiro/${dir}`,
      path.join(targetRoot, dir),
      { strategy: 'preserve-relative-path' }
    ));
  }
  if (!normalized.startsWith('.kiro/')) {
    return null;
  }
  const rest = normalized.slice('.kiro/'.length).split('/');
  if (!KIRO_PLATFORM_DIRS.includes(rest[0])) {
    return [];
  }
  return [createRemappedOperation(
    adapter,
    moduleId,
    sourceRelativePath,
    path.join(targetRoot, ...rest),
    { strategy: 'preserve-relative-path' }
  )];
}

// The content modules of a Kiro install: skills flat, the Kiro platform
// assets at their native places, everything else scaffolded as-is.
function createKiroModuleOperations(input, adapter) {
  const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
  return modules.flatMap(module => {
    const paths = Array.isArray(module.paths) ? module.paths : [];
    return paths
      .filter(p => !isForeignPlatformPath(p, adapter.target) && !isKiroExcludedPath(p))
      .flatMap(sourceRelativePath => (
        planKiroPlatformOperations(adapter, module.id, sourceRelativePath, targetRoot)
        ?? [planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot)]
      ));
  });
}

module.exports = {
  KIRO_PLATFORM_DIRS,
  createKiroModuleOperations,
  isKiroExcludedPath,
  planKiroPlatformOperations,
};
