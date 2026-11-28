'use strict';

const path = require('node:path');

const { resolveHomeOverride } = require('../home-override');
const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  GROK_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH,
  GROK_SESSION_START_SOURCE_RELATIVE_PATH,
  resolveGrokGuardianAdapterDestination,
} = require('../grok-hooks');

const LIBRARY_FAMILIES = new Set(['agents', 'commands', 'rules']);
const LIBRARY_ROOT_SEGMENTS = ['egc', 'library'];

function resolveGrokHome(input = {}) {
  return resolveHomeOverride(input, 'GROK_HOME', ['.grok']);
}

function relocateLibraryFolders(operations, targetRoot) {
  return operations.map(operation => {
    const relative = path.relative(targetRoot, operation.destinationPath).split(path.sep);
    if (!LIBRARY_FAMILIES.has(relative[0])) return operation;
    return { ...operation, destinationPath: path.join(targetRoot, ...LIBRARY_ROOT_SEGMENTS, ...relative) };
  });
}

// The Guardian, then the session hooks: SessionStart (the Team Brain pull and
// the session marker, through the Grok wrapper of the shared host session
// start) and Stop (the push), each as a whole file EGC owns under hooks/,
// with the runtime they load copied with its paths kept and the files the
// Guardian already plants left to it.
function createGrokHookOperations(adapter, targetRoot, plannedDestinations) {
  const {
    BASH_GUARDIAN_HOOK_MODULE_ID,
    createAdapterStdinJsonCopyOperation,
    createBashGuardianScriptCopyOperations,
    createGrokGuardianHookFileOperation,
    createGrokSessionHookFileOperations,
    createHostSessionHookCopyOperations,
    createWriteValidatorScriptCopyOperation,
  } = require('../claude-settings-hooks');
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );
  const adapterDestination = resolveGrokGuardianAdapterDestination(targetRoot);
  const gates = [
    ...createBashGuardianScriptCopyOperations(remap, targetRoot),
    createWriteValidatorScriptCopyOperation(remap, targetRoot),
    createAdapterStdinJsonCopyOperation(remap, targetRoot),
    remap(BASH_GUARDIAN_HOOK_MODULE_ID, GROK_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH, adapterDestination, { strategy: 'preserve-relative-path' }),
    createGrokGuardianHookFileOperation(targetRoot, adapterDestination),
  ];
  const planned = new Set([...plannedDestinations, ...gates.map(operation => operation.destinationPath)]);
  return [
    ...gates,
    ...createHostSessionHookCopyOperations(remap, targetRoot, GROK_SESSION_START_SOURCE_RELATIVE_PATH, planned),
    ...createGrokSessionHookFileOperations(targetRoot),
  ];
}

function planGrokOperations(input, adapter) {
  const targetRoot = adapter.resolveRoot(input ?? {});
  const moduleOperations = relocateLibraryFolders(createFlatSkillPlanOperations(input, adapter), targetRoot);
  return [
    ...moduleOperations,
    ...createGrokHookOperations(adapter, targetRoot, new Set(moduleOperations.map(operation => operation.destinationPath))),
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
