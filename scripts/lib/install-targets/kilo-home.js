'use strict';

const os = require('node:os');
const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  planFlatAgentOperations,
  resolveModulesPlan,
} = require('./helpers');
const { OPENCODE_AGENT_FRONTMATTER_TRANSFORM } = require('../install/copy-transforms');
const { createOpenCodePluginOperations } = require('../opencode-plugin-operations');

const LIBRARY_ROOT_SEGMENTS = ['egc', 'library'];

function resolveKiloConfigDir(input = {}) {
  const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
  const configured = process.env.XDG_CONFIG_HOME;
  return path.join(configured ? path.resolve(configured) : path.join(home, '.config'), 'kilo');
}

function planFlatSkill(adapter, moduleId, sourceRelativePath, normalizedPath, targetRoot) {
  const parts = normalizedPath.slice('skills/'.length).split('/');
  const flatRemainder = parts.length >= 2 ? parts.slice(1).join('/') : parts.join('/');
  return createRemappedOperation(adapter, moduleId, sourceRelativePath, path.join(targetRoot, 'skills', flatRemainder), {
    strategy: 'preserve-relative-path',
  });
}

function planKiloPath(adapter, module, sourceRelativePath, planningInput, targetRoot) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);
  if (normalizedPath === '.opencode' || normalizedPath.startsWith('.opencode/')) return [];
  if (normalizedPath.startsWith('skills/')) {
    return [planFlatSkill(adapter, module.id, sourceRelativePath, normalizedPath, targetRoot)];
  }
  if (normalizedPath === 'agents' || normalizedPath.startsWith('agents/')) {
    return planFlatAgentOperations(adapter, module.id, sourceRelativePath, planningInput, targetRoot, OPENCODE_AGENT_FRONTMATTER_TRANSFORM);
  }
  if (normalizedPath === 'rules' || normalizedPath.startsWith('rules/')) {
    return [createRemappedOperation(adapter, module.id, sourceRelativePath, path.join(targetRoot, ...LIBRARY_ROOT_SEGMENTS, ...normalizedPath.split('/')), {
      strategy: 'preserve-relative-path',
    })];
  }
  return [adapter.createScaffoldOperation(module.id, sourceRelativePath, planningInput)];
}

function planKiloOperations(input, adapter) {
  const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
  const moduleOperations = modules.flatMap(module => (Array.isArray(module.paths) ? module.paths : [])
    .filter(sourceRelativePath => !isForeignPlatformPath(sourceRelativePath, adapter.target))
    .flatMap(sourceRelativePath => planKiloPath(adapter, module, sourceRelativePath, planningInput, targetRoot)));
  return [...moduleOperations, ...createOpenCodePluginOperations(adapter, targetRoot)];
}

const baseAdapter = createInstallTargetAdapter({
  id: 'kilo-home',
  target: 'kilo',
  kind: 'home',
  resolveRoot(input = {}) {
    return resolveKiloConfigDir(input);
  },
  installStatePathSegments: ['egc', 'install-state.json'],
  planOperations: planKiloOperations,
});

module.exports = Object.freeze({ ...baseAdapter, resolveKiloConfigDir });
