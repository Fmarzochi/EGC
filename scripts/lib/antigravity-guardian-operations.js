'use strict';

// Install operations for the EGC Guardian on Antigravity, in Antigravity's
// own hooks.json format (antigravity-guardian-hooks.js). The scripts are
// copied explicitly, as for every other host adapter, so a minimal install
// that skips the hooks-runtime module still has what the hook entry runs:
// the adapter, both Guardian validators with the helpers they require, and
// the shared stdin reader.

const {
  BASH_GUARDIAN_HOOK_MODULE_ID,
  HOOK_OPERATION_KIND,
  createAdapterStdinJsonCopyOperation,
  createBashGuardianScriptCopyOperations,
  createWriteValidatorScriptCopyOperation,
} = require('./claude-settings-hooks');
const {
  ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  ANTIGRAVITY_GUARDIAN_HOOK_TAG,
  resolveAdapterScriptDestination,
} = require('./antigravity-guardian-hooks');

// remap: (moduleId, sourceRelativePath, destinationPath, options) => operation
function createAntigravityGuardianOperations(remap, targetRoot, hooksJsonPath) {
  const adapterScriptPath = resolveAdapterScriptDestination(targetRoot);
  return [
    ...createBashGuardianScriptCopyOperations(remap, targetRoot),
    createWriteValidatorScriptCopyOperation(remap, targetRoot),
    remap(BASH_GUARDIAN_HOOK_MODULE_ID, ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH, adapterScriptPath, { strategy: 'preserve-relative-path' }),
    createAdapterStdinJsonCopyOperation(remap, targetRoot),
    {
      kind: HOOK_OPERATION_KIND,
      moduleId: BASH_GUARDIAN_HOOK_MODULE_ID,
      sourceRelativePath: ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
      destinationPath: hooksJsonPath,
      strategy: HOOK_OPERATION_KIND,
      ownership: 'managed',
      scaffoldOnly: false,
      hookEvent: ANTIGRAVITY_GUARDIAN_HOOK_TAG,
      hookScriptPath: adapterScriptPath,
    },
  ];
}

module.exports = { createAntigravityGuardianOperations };
