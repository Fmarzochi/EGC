'use strict';

// EGC-494/EGC-498: every Kiro install registers the Guardian Bash validator
// on preToolUse (scoped to the execute_bash matcher, baked into the
// merged entry by kiro-guardian-hooks.js), even when no content modules
// are selected -- the same "deterministic, unconditional" pattern
// windsurf-gateguard-operations.js already uses for its own security
// hooks. Shared between kiro-home.js and kiro-project.js: both roots use
// this identical operation shape, differing only in rootSegments/
// installStatePathSegments.

const { createFlatHookGuardianOperations } = require('./guardian-flat-hook-operations');
const {
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_TOOL_USE_EVENT,
  resolveAgentConfigPath,
  resolveGuardianAdapterScriptDestination,
} = require('./kiro-guardian-hooks');

function createKiroGuardianOperations(adapter, targetRoot, createRemappedOperation) {
  return createFlatHookGuardianOperations({
    adapter,
    targetRoot,
    createRemappedOperation,
    guardianAdapterSourceRelativePath: GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    hookEvent: PRE_TOOL_USE_EVENT,
    resolveAgentConfigPath,
    resolveGuardianAdapterScriptDestination,
  });
}

module.exports = { createKiroGuardianOperations };
