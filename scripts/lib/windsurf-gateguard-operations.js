'use strict';

// Windsurf Cascade Hooks (docs: https://docs.windsurf.com/windsurf/cascade/hooks,
// redirects to https://docs.devin.ai/desktop/cascade/hooks) reads
// ~/.codeium/windsurf/hooks.json for Devin Desktop (home) and
// <project>/.windsurf/hooks.json for the workspace level (project), merged
// together with the user-level file at hook-execution time. pre_write_code
// and pre_run_command are real pre-action hooks that can block by exiting 2,
// but they use a different stdin/exit-code contract than Claude Code's, so
// the gate runs through scripts/hooks/windsurf-gateguard-adapter.js instead
// of gateguard-fact-force.js's own CLI entrypoint directly. Shared between
// windsurf-home.js and windsurf-project.js: both roots use this identical
// operation shape, differing only in rootSegments/installStatePathSegments.

const {
  GATEGUARD_HOOK_MODULE_ID,
  HOOK_OPERATION_KIND,
  BASH_GUARDIAN_HOOK_MODULE_ID,
  createGateGuardScriptCopyOperations,
  createBashGuardianScriptCopyOperations,
  createAdapterStdinJsonCopyOperation,
} = require('./claude-settings-hooks');
const {
  ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_RUN_COMMAND_EVENT,
  PRE_WRITE_CODE_EVENT,
  resolveAdapterScriptDestination,
  resolveGuardianAdapterScriptDestination,
  resolveHooksJsonPath,
} = require('./windsurf-gateguard-hooks');

function createWindsurfGateGuardOperations(adapter, targetRoot, createRemappedOperation) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  const scriptCopyOperations = createGateGuardScriptCopyOperations(remap, targetRoot);

  const adapterScriptDestination = resolveAdapterScriptDestination(targetRoot);
  const adapterCopyOperation = createRemappedOperation(
    adapter,
    GATEGUARD_HOOK_MODULE_ID,
    ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    adapterScriptDestination,
    { strategy: 'preserve-relative-path' }
  );

  const hooksJsonPath = resolveHooksJsonPath(targetRoot);
  const mergeOperations = [PRE_WRITE_CODE_EVENT, PRE_RUN_COMMAND_EVENT].map(event => ({
    kind: HOOK_OPERATION_KIND,
    moduleId: GATEGUARD_HOOK_MODULE_ID,
    sourceRelativePath: ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: hooksJsonPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: event,
    hookScriptPath: adapterScriptDestination,
  }));

  // EGC Guardian: the GateGuard adapter above only forces investigation
  // before a risky action, it never checks a Bash command against the
  // Guardian's actual allowlist/denylist. 2026-07-27 audit (EGC-460/462)
  // found Windsurf's adapter called only gateguard-fact-force.js, never
  // pre-bash-guardian-validate.js. Registered on pre_run_command only (the
  // Guardian validates shell commands, not file writes).
  const guardianScriptCopyOperations = createBashGuardianScriptCopyOperations(remap, targetRoot);
  const guardianAdapterScriptDestination = resolveGuardianAdapterScriptDestination(targetRoot);
  const guardianAdapterCopyOperation = createRemappedOperation(
    adapter,
    BASH_GUARDIAN_HOOK_MODULE_ID,
    GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    guardianAdapterScriptDestination,
    { strategy: 'preserve-relative-path' }
  );
  const guardianMergeOperation = {
    kind: HOOK_OPERATION_KIND,
    moduleId: BASH_GUARDIAN_HOOK_MODULE_ID,
    sourceRelativePath: GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: hooksJsonPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_RUN_COMMAND_EVENT,
    hookScriptPath: guardianAdapterScriptDestination,
  };

  const adapterStdinJsonCopyOperation = createAdapterStdinJsonCopyOperation(remap, targetRoot);

  return [
    ...scriptCopyOperations,
    adapterCopyOperation,
    ...mergeOperations,
    ...guardianScriptCopyOperations,
    guardianAdapterCopyOperation,
    adapterStdinJsonCopyOperation,
    guardianMergeOperation,
  ];
}

module.exports = { createWindsurfGateGuardOperations };
