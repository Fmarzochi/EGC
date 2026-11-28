'use strict';

// EGC-498 (corrected): OpenHands has a real pre_tool_use hook (verified
// against OpenHands/docs' own hooks.mdx, not an earlier internal report
// which incorrectly classified it as prompt-only). EGC wires the project
// file only. OpenHands also reads a global ~/.openhands/hooks.json, but
// only when the project has none (HookConfig.load in the OpenHands SDK
// takes the first file that exists); see docs/spec/integration-tiers.md.

const path = require('node:path');

const {
  BASH_GUARDIAN_HOOK_MODULE_ID,
  HOOK_OPERATION_KIND,
  HOST_SESSION_HOOK_MODULE_ID,
  TEAM_SYNC_STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  createBashGuardianScriptCopyOperations,
  createAdapterStdinJsonCopyOperation,
  createHostSessionHookCopyOperations,
  resolveTeamSyncStopHookScriptDestination,
} = require('./claude-settings-hooks');
const {
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_TOOL_USE_EVENT,
  SESSION_START_EVENT,
  STOP_EVENT,
  resolveGuardianAdapterScriptDestination,
  resolveHooksJsonPath,
} = require('./openhands-guardian-hooks');

// The session hooks, in the same hooks.json ([OpenHands hooks](https://docs.openhands.dev/openhands/usage/customization/hooks),
// read on 2026-11-27): session_start gets event_type, session_id and
// working_dir and reads additionalContext back, so the project memory
// reaches the session and the Team Brain is pulled when the team asks for
// it; stop pushes what changed. Both go with no matcher, as the file takes
// a session event.
const SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/openhands-session-start.js';

function createOpenHandsHookMergeOperation(hooksJsonPath, hookEvent, sourceRelativePath, hookScriptPath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: HOST_SESSION_HOOK_MODULE_ID,
    sourceRelativePath,
    destinationPath: hooksJsonPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent,
    hookScriptPath,
  };
}

function createOpenHandsSessionOperations(adapter, targetRoot, projectRoot, createRemappedOperation, plannedDestinations) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );
  const hooksJsonPath = resolveHooksJsonPath(projectRoot);
  return [
    ...createHostSessionHookCopyOperations(remap, targetRoot, SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH, plannedDestinations),
    createOpenHandsHookMergeOperation(hooksJsonPath, SESSION_START_EVENT, SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH, path.join(targetRoot, ...SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH.split('/'))),
    createOpenHandsHookMergeOperation(hooksJsonPath, STOP_EVENT, TEAM_SYNC_STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH, resolveTeamSyncStopHookScriptDestination(targetRoot)),
  ];
}

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

module.exports = { createOpenHandsGuardianOperations, createOpenHandsSessionOperations };
