'use strict';

const os = require('node:os');
const path = require('node:path');

const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  GROK_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH,
  resolveGrokGuardianAdapterDestination,
} = require('../grok-hooks');

const LIBRARY_FAMILIES = new Set(['agents', 'commands', 'rules']);
const LIBRARY_ROOT_SEGMENTS = ['egc', 'library'];

function resolveGrokHome(input = {}) {
  const home = typeof input === 'string' ? input : (input?.homeDir || os.homedir());
  const configured = process.env.GROK_HOME;
  if (configured) {
    if (configured === '~' || configured.startsWith('~/')) {
      return path.join(home, configured.slice(1));
    }
    return path.resolve(configured);
  }
  return path.join(home, '.grok');
}

function relocateLibraryFolders(operations, targetRoot) {
  return operations.map(operation => {
    const relative = path.relative(targetRoot, operation.destinationPath).split(path.sep);
    if (!LIBRARY_FAMILIES.has(relative[0])) return operation;
    return { ...operation, destinationPath: path.join(targetRoot, ...LIBRARY_ROOT_SEGMENTS, ...relative) };
  });
}

function createGrokGuardianOperations(adapter, targetRoot) {
  const {
    BASH_GUARDIAN_HOOK_MODULE_ID,
    createAdapterStdinJsonCopyOperation,
    createBashGuardianScriptCopyOperations,
    createGrokGuardianHookFileOperation,
    createWriteValidatorScriptCopyOperation,
  } = require('../claude-settings-hooks');
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );
  const adapterDestination = resolveGrokGuardianAdapterDestination(targetRoot);
  return [
    ...createBashGuardianScriptCopyOperations(remap, targetRoot),
    createWriteValidatorScriptCopyOperation(remap, targetRoot),
    createAdapterStdinJsonCopyOperation(remap, targetRoot),
    remap(BASH_GUARDIAN_HOOK_MODULE_ID, GROK_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH, adapterDestination, { strategy: 'preserve-relative-path' }),
    createGrokGuardianHookFileOperation(targetRoot, adapterDestination),
  ];
}

function planGrokOperations(input, adapter) {
  const targetRoot = adapter.resolveRoot(input ?? {});
  return [
    ...relocateLibraryFolders(createFlatSkillPlanOperations(input, adapter), targetRoot),
    ...createGrokGuardianOperations(adapter, targetRoot),
  ];
}

const baseAdapter = createInstallTargetAdapter({
  id: 'grok-home',
  target: 'grok',
  kind: 'home',
  resolveRoot(input = {}) {
    return resolveGrokHome(input);
  },
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.grok',
  planOperations: planGrokOperations,
});

module.exports = Object.freeze({ ...baseAdapter, resolveGrokHome });
