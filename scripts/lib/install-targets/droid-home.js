'use strict';

const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  planFlatSkillOperation,
  resolveModulesPlan,
} = require('./helpers');

const LIBRARY_FAMILIES = new Set(['agents', 'rules']);
const LIBRARY_ROOT_SEGMENTS = ['egc', 'library'];
const SHELL_MATCHER = 'Execute';
const WRITE_MATCHER = 'Edit|Create|ApplyPatch';

function planDroidPath(adapter, module, sourceRelativePath, planningInput, targetRoot) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);
  if (LIBRARY_FAMILIES.has(normalizedPath.split('/')[0])) {
    return createRemappedOperation(adapter, module.id, sourceRelativePath, path.join(targetRoot, ...LIBRARY_ROOT_SEGMENTS, ...normalizedPath.split('/')), {
      strategy: 'preserve-relative-path',
    });
  }
  return planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot);
}

function createDroidHookOperations(adapter, targetRoot) {
  const {
    createBashGuardianHookMergeOperationForDestination,
    createBashGuardianScriptCopyOperations,
    createCrusherHookMergeOperationForDestination,
    createCrusherScriptCopyOperations,
    createWriteValidatorHookMergeOperationForDestination,
    createWriteValidatorScriptCopyOperation,
  } = require('../claude-settings-hooks');
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );
  const settingsPath = path.join(targetRoot, 'settings.json');
  const hooksDir = path.join(targetRoot, 'scripts', 'hooks');
  return [
    ...createBashGuardianScriptCopyOperations(remap, targetRoot),
    createBashGuardianHookMergeOperationForDestination(settingsPath, path.join(hooksDir, 'pre-bash-guardian-validate.js'), SHELL_MATCHER),
    createWriteValidatorScriptCopyOperation(remap, targetRoot),
    createWriteValidatorHookMergeOperationForDestination(settingsPath, path.join(hooksDir, 'pre-write-guardian-validate.js'), WRITE_MATCHER),
    ...createCrusherScriptCopyOperations(remap, targetRoot),
    createCrusherHookMergeOperationForDestination(settingsPath, path.join(hooksDir, 'crusher-hook.js'), SHELL_MATCHER),
  ];
}

function planDroidOperations(input, adapter) {
  const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
  const moduleOperations = modules.flatMap(module => (Array.isArray(module.paths) ? module.paths : [])
    .filter(sourceRelativePath => !isForeignPlatformPath(sourceRelativePath, adapter.target))
    .map(sourceRelativePath => planDroidPath(adapter, module, sourceRelativePath, planningInput, targetRoot)));
  return [...moduleOperations, ...createDroidHookOperations(adapter, targetRoot)];
}

module.exports = createInstallTargetAdapter({
  id: 'droid-home',
  target: 'droid',
  kind: 'home',
  rootSegments: ['.factory'],
  installStatePathSegments: ['egc', 'install-state.json'],
  planOperations: planDroidOperations,
});
