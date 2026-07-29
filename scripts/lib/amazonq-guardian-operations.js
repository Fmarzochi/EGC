'use strict';

// EGC-498 (corrected): Amazon Q Developer CLI has a real preToolUse hook
// (verified against aws/amazon-q-developer-cli's own docs, not the earlier
// Multica report which incorrectly classified it as prompt-only). Shared
// between amazonq-project.js and amazonq-home.js: both roots use this
// identical operation shape, differing only in rootSegments/
// installStatePathSegments.

const {
  BASH_GUARDIAN_HOOK_MODULE_ID,
  HOOK_OPERATION_KIND,
  createBashGuardianScriptCopyOperations,
  createAdapterStdinJsonCopyOperation,
} = require('./claude-settings-hooks');
const {
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  OPERATION_DISPATCH_TAG,
  resolveAgentConfigPath,
  resolveGuardianAdapterScriptDestination,
} = require('./amazonq-guardian-hooks');

function createAmazonQGuardianOperations(adapter, targetRoot, createRemappedOperation) {
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

  const agentConfigPath = resolveAgentConfigPath(targetRoot);
  const mergeOperation = {
    kind: HOOK_OPERATION_KIND,
    moduleId: BASH_GUARDIAN_HOOK_MODULE_ID,
    sourceRelativePath: GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: agentConfigPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: OPERATION_DISPATCH_TAG,
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

module.exports = { createAmazonQGuardianOperations };
