'use strict';

// Devin Desktop hooks. Cascade, whose pre_write_code/pre_run_command events
// EGC used to register in hooks.json, was removed on 2026-09-08; Devin Local
// replaced it and reads PreToolUse hooks in the Claude Code settings shape
// (see devin-local-hooks.js for the locations and the matchers). The adapter
// scripts still translate the wire contract (exit code 2 with the reason on
// stderr), so they are copied under the target root and the Devin config
// points at them. Shared between windsurf-home.js and windsurf-project.js:
// both use this identical operation shape, differing only in the target root
// and the config file.

const {
  GATEGUARD_HOOK_MODULE_ID,
  HOOK_OPERATION_KIND,
  BASH_GUARDIAN_HOOK_MODULE_ID,
  PRE_TOOL_USE_EVENT,
  createGateGuardScriptCopyOperations,
  createBashGuardianScriptCopyOperations,
  createAdapterStdinJsonCopyOperation,
} = require('./claude-settings-hooks');
const {
  ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  resolveAdapterScriptDestination,
  resolveGuardianAdapterScriptDestination,
} = require('./windsurf-gateguard-hooks');
const {
  DEVIN_GATEGUARD_MATCHER,
  DEVIN_GUARDIAN_MATCHER,
} = require('./devin-local-hooks');

function devinPreToolUseOperation(moduleId, sourceRelativePath, devinConfigPath, matcher, hookScriptPath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId,
    sourceRelativePath,
    destinationPath: devinConfigPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_TOOL_USE_EVENT,
    hookMatcher: matcher,
    hookScriptPath,
  };
}

function createWindsurfGateGuardOperations(adapter, targetRoot, createRemappedOperation, devinConfigPath) {
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
  // GateGuard forces investigation before the first shell command and the
  // first write to each file, so it covers exec and every file-writing tool.
  const gateGuardMergeOperation = devinPreToolUseOperation(
    GATEGUARD_HOOK_MODULE_ID,
    ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    devinConfigPath,
    DEVIN_GATEGUARD_MATCHER,
    adapterScriptDestination
  );

  // EGC Guardian: the GateGuard adapter above only forces investigation
  // before a risky action, it never checks a command against the Guardian's
  // actual allowlist/denylist (2026-07-27 audit, EGC-460/462). The Guardian
  // validates shell commands, not file writes, so it matches exec only.
  const guardianScriptCopyOperations = createBashGuardianScriptCopyOperations(remap, targetRoot);
  const guardianAdapterScriptDestination = resolveGuardianAdapterScriptDestination(targetRoot);
  const guardianAdapterCopyOperation = createRemappedOperation(
    adapter,
    BASH_GUARDIAN_HOOK_MODULE_ID,
    GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    guardianAdapterScriptDestination,
    { strategy: 'preserve-relative-path' }
  );
  const guardianMergeOperation = devinPreToolUseOperation(
    BASH_GUARDIAN_HOOK_MODULE_ID,
    GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    devinConfigPath,
    DEVIN_GUARDIAN_MATCHER,
    guardianAdapterScriptDestination
  );

  const adapterStdinJsonCopyOperation = createAdapterStdinJsonCopyOperation(remap, targetRoot);

  return [
    ...scriptCopyOperations,
    adapterCopyOperation,
    gateGuardMergeOperation,
    ...guardianScriptCopyOperations,
    guardianAdapterCopyOperation,
    adapterStdinJsonCopyOperation,
    guardianMergeOperation,
  ];
}

module.exports = { createWindsurfGateGuardOperations };
