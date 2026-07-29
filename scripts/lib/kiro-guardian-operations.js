'use strict';

// EGC-494/EGC-498: every Kiro install registers the Guardian Bash validator
// on preToolUse (scoped to the execute_bash matcher, baked into the
// merged entry by kiro-guardian-hooks.js), even when no content modules
// are selected -- the same "deterministic, unconditional" pattern
// windsurf-gateguard-operations.js already uses for its own security
// hooks. Shared between kiro-home.js and kiro-project.js: both roots use
// this identical operation shape, differing only in rootSegments/
// installStatePathSegments.

const {
  BASH_GUARDIAN_HOOK_MODULE_ID,
  HOOK_OPERATION_KIND,
  createBashGuardianScriptCopyOperations,
} = require('./claude-settings-hooks');
const {
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_TOOL_USE_EVENT,
  resolveAgentConfigPath,
  resolveGuardianAdapterScriptDestination,
} = require('./kiro-guardian-hooks');

function createKiroGuardianOperations(adapter, targetRoot, createRemappedOperation) {
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
    hookEvent: PRE_TOOL_USE_EVENT,
    hookScriptPath: adapterScriptDestination,
  };

  return [
    ...guardianScriptCopyOperations,
    adapterCopyOperation,
    mergeOperation,
  ];
}

module.exports = { createKiroGuardianOperations };
