'use strict';

// EGC-498 (corrected): Amazon Q Developer CLI has a real preToolUse hook
// (verified against aws/amazon-q-developer-cli's own docs, not the earlier
// Multica report which incorrectly classified it as prompt-only). Shared
// between amazonq-project.js and amazonq-home.js: both roots use this
// identical operation shape, differing only in rootSegments/
// installStatePathSegments.

const { createFlatHookGuardianOperations } = require('./guardian-flat-hook-operations');
const {
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  OPERATION_DISPATCH_TAG,
  resolveAgentConfigPath,
  resolveGuardianAdapterScriptDestination,
} = require('./amazonq-guardian-hooks');

function createAmazonQGuardianOperations(adapter, targetRoot, createRemappedOperation) {
  return createFlatHookGuardianOperations({
    adapter,
    targetRoot,
    createRemappedOperation,
    guardianAdapterSourceRelativePath: GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    hookEvent: OPERATION_DISPATCH_TAG,
    resolveAgentConfigPath,
    resolveGuardianAdapterScriptDestination,
  });
}

module.exports = { createAmazonQGuardianOperations };
