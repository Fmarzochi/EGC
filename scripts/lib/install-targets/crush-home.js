'use strict';

const os = require('node:os');
const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  planFlatSkillOperation,
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
  const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
  if (process.env.CRUSH_GLOBAL_CONFIG) {
    const custom = process.env.CRUSH_GLOBAL_CONFIG;
    return path.extname(custom).toLowerCase() === '.json' ? path.dirname(custom) : custom;
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'crush');
  }
  if (process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)) {
    return path.join(process.env.XDG_CONFIG_HOME, 'crush');
  }
  return path.join(home, '.config', 'crush');
}

function resolveCrushConfigPath(input = {}) {
  if (process.env.CRUSH_GLOBAL_CONFIG) {
    const custom = process.env.CRUSH_GLOBAL_CONFIG;
    return path.extname(custom).toLowerCase() === '.json' ? custom : path.join(custom, 'crush.json');
  }
  return path.join(resolveCrushConfigDir(input), 'crush.json');
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

const baseAdapter = createInstallTargetAdapter({
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
    const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
    return [adapter.resolveRoot(input), path.join(home, '.agents')];
  },
  planOperations(input, adapter) {
    const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
    const sharedAgentsRoot = path.join(planningInput.homeDir || os.homedir(), '.agents');

    const moduleOperations = modules.flatMap(module => {
      const paths = (Array.isArray(module.paths) ? module.paths : [])
        .filter(p => !isForeignPlatformPath(p, adapter.target));
      return paths.map(sourceRelativePath => planFlatSkillOperation(
        adapter,
        module.id,
        sourceRelativePath,
        planningInput,
        targetRoot,
        path.join(sharedAgentsRoot, 'skills')
      ));
    });

    return [
      ...moduleOperations,
      ...createCrushOperations(adapter, targetRoot),
    ];
  },
});

const adapter = Object.freeze(Object.assign({}, baseAdapter, {
  resolveCrushConfigDir,
  resolveCrushConfigPath,
}));

module.exports = adapter;

