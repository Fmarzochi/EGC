'use strict';

const os = require('node:os');
const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  resolveModulesPlan,
} = require('./helpers');
const {
  createCrusherScriptCopyOperations,
} = require('../claude-settings-hooks');
const {
  createCrushCrusherHookMergeOperation,
  createCrushGuardianHookMergeOperation,
  createCrushGuardianScriptCopyOperations,
} = require('../crush-settings-hooks');

function resolveCrushConfigDir(input = {}) {
  const home = input.homeDir || os.homedir();
  if (process.env.CRUSH_GLOBAL_CONFIG) {
    const custom = process.env.CRUSH_GLOBAL_CONFIG;
    return path.extname(custom).toLowerCase() === '.json' ? path.dirname(custom) : custom;
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'crush');
  }
  return path.join(home, '.config', 'crush');
}

function createCrushOperations(adapter, targetRoot) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  return [
    ...createCrushGuardianScriptCopyOperations(remap, targetRoot),
    ...createCrusherScriptCopyOperations(remap, targetRoot),
    createCrushGuardianHookMergeOperation(targetRoot),
    createCrushCrusherHookMergeOperation(targetRoot),
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'crush-home',
  target: 'crush',
  kind: 'home',
  rootSegments: ['.config', 'crush'],
  installStatePathSegments: ['egc', 'crush-install-state.json'],
  nativeRootRelativePath: '.config/crush',
  resolveRoot(input = {}) {
    return resolveCrushConfigDir(input);
  },
  resolveManagedRoots(input = {}, adapter) {
    const home = input.homeDir || os.homedir();
    return [adapter.resolveRoot(input), path.join(home, '.agents')];
  },
  planOperations(input, adapter) {
    const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
    const sharedAgentsRoot = path.join(planningInput.homeDir || os.homedir(), '.agents');

    const moduleOperations = modules.flatMap(module => {
      const paths = (Array.isArray(module.paths) ? module.paths : [])
        .filter(p => !isForeignPlatformPath(p, adapter.target));
      return paths.map(sourceRelativePath => {
        const normalizedPath = normalizeRelativePath(sourceRelativePath);
        if (normalizedPath.startsWith('skills/')) {
          const parts = normalizedPath.slice('skills/'.length).split('/');
          const flatRemainder = parts.length >= 2 ? parts.slice(1).join('/') : parts.join('/');
          return createRemappedOperation(
            adapter,
            module.id,
            sourceRelativePath,
            path.join(sharedAgentsRoot, 'skills', flatRemainder),
            { strategy: 'preserve-relative-path' }
          );
        }
        return adapter.createScaffoldOperation(module.id, sourceRelativePath, planningInput);
      });
    });

    return [
      ...moduleOperations,
      ...createCrushOperations(adapter, targetRoot),
    ];
  },
});
