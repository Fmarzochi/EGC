'use strict';

// Shared operation-list builder for hosts whose Guardian hook lives in a
// flat {hooks: {<event>: [{matcher, command}]}} JSON config file (Kiro,
// Amazon Q -- both confirmed against their own docs to use this exact
// shape). Every such host needs the identical four operations (copy the
// shared Guardian scripts, copy its own translation adapter, copy the
// shared stdin-JSON reader, merge the hook entry into its config file);
// only the source paths, the merged event value, and where the config
// file lives differ per host.

const {
  BASH_GUARDIAN_HOOK_MODULE_ID,
  HOOK_OPERATION_KIND,
  createBashGuardianScriptCopyOperations,
  createAdapterStdinJsonCopyOperation,
} = require('./claude-settings-hooks');

function createFlatHookGuardianOperations({
  adapter,
  targetRoot,
  createRemappedOperation,
  guardianAdapterSourceRelativePath,
  hookEvent,
  resolveAgentConfigPath,
  resolveGuardianAdapterScriptDestination,
}) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  const guardianScriptCopyOperations = createBashGuardianScriptCopyOperations(remap, targetRoot);

  const adapterScriptDestination = resolveGuardianAdapterScriptDestination(targetRoot);
  const adapterCopyOperation = createRemappedOperation(
    adapter,
    BASH_GUARDIAN_HOOK_MODULE_ID,
    guardianAdapterSourceRelativePath,
    adapterScriptDestination,
    { strategy: 'preserve-relative-path' }
  );

  const agentConfigPath = resolveAgentConfigPath(targetRoot);
  const mergeOperation = {
    kind: HOOK_OPERATION_KIND,
    moduleId: BASH_GUARDIAN_HOOK_MODULE_ID,
    sourceRelativePath: guardianAdapterSourceRelativePath,
    destinationPath: agentConfigPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent,
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

module.exports = { createFlatHookGuardianOperations };
