'use strict';

// Install operations for the GateGuard fact-forcing gate and the session-mesh
// notice on Antigravity, as named hooks in Antigravity's own format
// (antigravity-gateguard-hooks.js, antigravity-mesh-hooks.js), beside the
// Guardian's (antigravity-guardian-operations.js). The scripts each hook
// runs are copied explicitly, so a minimal install that skips the
// hooks-runtime module still has them: the gate with the helper it requires,
// the shared mesh script, and the adapter of each. The gate also requires
// shell-split.js and wrapper-options.js, which arrive with the Guardian
// operations every Antigravity install plans beside these.

const {
  GATEGUARD_HOOK_MODULE_ID,
  HOOK_OPERATION_KIND,
  MESH_NOTICE_HOOK_MODULE_ID,
  createGateGuardScriptCopyOperations,
  createMeshNoticeScriptCopyOperations,
} = require('./claude-settings-hooks');
const gateguardHook = require('./antigravity-gateguard-hooks');
const meshHook = require('./antigravity-mesh-hooks');

function namedHookOperation(moduleId, hookTag, sourceRelativePath, hooksJsonPath, adapterScriptPath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId,
    sourceRelativePath,
    destinationPath: hooksJsonPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: hookTag,
    hookScriptPath: adapterScriptPath,
  };
}

// remap: (moduleId, sourceRelativePath, destinationPath, options) => operation
function createAntigravityGateGuardOperations(remap, targetRoot, hooksJsonPath) {
  const adapterScriptPath = gateguardHook.resolveAdapterScriptDestination(targetRoot);
  return [
    ...createGateGuardScriptCopyOperations(remap, targetRoot),
    remap(GATEGUARD_HOOK_MODULE_ID, gateguardHook.ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH, adapterScriptPath, { strategy: 'preserve-relative-path' }),
    namedHookOperation(
      GATEGUARD_HOOK_MODULE_ID,
      gateguardHook.ANTIGRAVITY_GATEGUARD_HOOK_TAG,
      gateguardHook.ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
      hooksJsonPath,
      adapterScriptPath
    ),
  ];
}

function createAntigravityMeshNoticeOperations(remap, targetRoot, hooksJsonPath) {
  const adapterScriptPath = meshHook.resolveAdapterScriptDestination(targetRoot);
  return [
    ...createMeshNoticeScriptCopyOperations(remap, targetRoot),
    remap(MESH_NOTICE_HOOK_MODULE_ID, meshHook.ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH, adapterScriptPath, { strategy: 'preserve-relative-path' }),
    namedHookOperation(
      MESH_NOTICE_HOOK_MODULE_ID,
      meshHook.ANTIGRAVITY_MESH_HOOK_TAG,
      meshHook.ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
      hooksJsonPath,
      adapterScriptPath
    ),
  ];
}

module.exports = { createAntigravityGateGuardOperations, createAntigravityMeshNoticeOperations };
