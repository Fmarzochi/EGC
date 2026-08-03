'use strict';

// EGC-498 (corrected): OpenHands has a real pre_tool_use hook (verified
// against OpenHands/docs' own hooks.mdx, not an earlier internal report
// which incorrectly classified it as prompt-only). Project-only --
// confirmed no global/home hooks.json path exists.

const {
  BASH_GUARDIAN_HOOK_MODULE_ID,
  HOOK_OPERATION_KIND,
  createBashGuardianScriptCopyOperations,
  createAdapterStdinJsonCopyOperation,
} = require('./claude-settings-hooks');
const {
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_TOOL_USE_EVENT,
  resolveGuardianAdapterScriptDestination,
  resolveHooksJsonPath,
} = require('./openhands-guardian-hooks');

function createOpenHandsGuardianOperations(adapter, targetRoot, projectRoot, createRemappedOperation) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  const guardianScriptCopyOperations = createBashGuardianScriptCopyOperations(remap, targetRoot);

  const adapterScriptDestination = resolveGuardianAdapterScriptDestination(targetRoot);
  const adapterCopyOperation = createRemappedOperation(
    adapter,
    BASH_GUARDIAN_HOOK_MODULE_ID,
    GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    adapterScriptDestination,
    { strategy: 'preserve-relative-path' }
  );

  const hooksJsonPath = resolveHooksJsonPath(projectRoot);
  const mergeOperation = {
    kind: HOOK_OPERATION_KIND,
    moduleId: BASH_GUARDIAN_HOOK_MODULE_ID,
    sourceRelativePath: GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: hooksJsonPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_TOOL_USE_EVENT,
    hookScriptPath: adapterScriptDestination,
  };

  const adapterStdinJsonCopyOperation = createAdapterStdinJsonCopyOperation(remap, targetRoot);

  return [
    ...guardianScriptCopyOperations,
    adapterCopyOperation,
    adapterStdinJsonCopyOperation,
    mergeOperation,
  ];
}

module.exports = { createOpenHandsGuardianOperations };
