'use strict';

const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  planFlatAgentOperations,
  planFlatSkillOperation,
  resolveModulesPlan,
} = require('./helpers');
const { OPENCODE_AGENT_FRONTMATTER_TRANSFORM } = require('../install/copy-transforms');
const { createOpenCodePluginOperations } = require('../opencode-plugin-operations');

const LIBRARY_ROOT_SEGMENTS = ['egc', 'library'];

function planForkPath(adapter, module, sourceRelativePath, planningInput, targetRoot) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);
  if (normalizedPath === '.opencode' || normalizedPath.startsWith('.opencode/')) return [];
  if (normalizedPath === 'agents' || normalizedPath.startsWith('agents/')) {
    return planFlatAgentOperations(adapter, module.id, sourceRelativePath, planningInput, targetRoot, OPENCODE_AGENT_FRONTMATTER_TRANSFORM);
  }
  if (normalizedPath === 'rules' || normalizedPath.startsWith('rules/')) {
    return [createRemappedOperation(adapter, module.id, sourceRelativePath, path.join(targetRoot, ...LIBRARY_ROOT_SEGMENTS, ...normalizedPath.split('/')), {
      strategy: 'preserve-relative-path',
    })];
  }
  return [planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot)];
}

function planForkOperations(input, adapter) {
  const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
  const moduleOperations = modules.flatMap(module => (Array.isArray(module.paths) ? module.paths : [])
    .filter(sourceRelativePath => !isForeignPlatformPath(sourceRelativePath, adapter.target))
    .flatMap(sourceRelativePath => planForkPath(adapter, module, sourceRelativePath, planningInput, targetRoot)));
  return [...moduleOperations, ...createOpenCodePluginOperations(adapter, targetRoot)];
}

function createOpenCodeForkHomeAdapter({ id, target, resolveRoot }) {
  return createInstallTargetAdapter({
    id,
    target,
    kind: 'home',
    resolveRoot(input = {}) {
      return resolveRoot(input);
    },
    installStatePathSegments: ['egc', 'install-state.json'],
    planOperations: planForkOperations,
  });
}

module.exports = { createOpenCodeForkHomeAdapter };
