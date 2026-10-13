'use strict';

// Per-event hook families (SessionStart, Stop, UserPromptSubmit, PreToolUse) and their merge operations.
// Part of the claude-settings-hooks.js split; that file re-exports the public surface.

const path = require('node:path');
const {
  SESSION_START_EVENT,
  STOP_EVENT,
  USER_PROMPT_SUBMIT_EVENT,
  PRE_TOOL_USE_EVENT,
  HOOK_OPERATION_KIND,
  HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  HOOK_MODULE_ID,
  STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  STOP_HOOK_MODULE_ID,
  INTUITION_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  INTUITION_HOOK_MODULE_ID,
  BASH_DISPATCHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  BASH_DISPATCHER_HOOK_MODULE_ID,
  WRITE_VALIDATOR_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  WRITE_VALIDATOR_HOOK_MODULE_ID,
  SCRUBBER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  SCRUBBER_HOOK_MODULE_ID,
  ROUTER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  ROUTER_HOOK_MODULE_ID,
  GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  GATEGUARD_HOOK_MODULE_ID,
  buildHookCommand,
  buildSessionStartCommand,
  buildStopCommand,
  resolveHookScriptDestination,
  resolveStopHookScriptDestination,
  resolveSettingsPath,
  hasHookEntry,
  addHookEntry,
  removeHookEntry,
  applyHookEntryToFile,
  removeHookEntryFromFile,
  inspectHookEntryFile,
} = require('./claude-settings-hook-core');

function hasSessionStartHook(settings, hookScriptPath) {
  return hasHookEntry(settings, SESSION_START_EVENT, hookScriptPath);
}

function addSessionStartHook(settings, hookScriptPath) {
  return addHookEntry(settings, SESSION_START_EVENT, hookScriptPath);
}

function removeSessionStartHook(settings, hookScriptPath) {
  return removeHookEntry(settings, SESSION_START_EVENT, hookScriptPath);
}

function applySessionStartHookToFile(settingsPath, hookScriptPath) {
  return applyHookEntryToFile(settingsPath, SESSION_START_EVENT, hookScriptPath);
}

function removeSessionStartHookFromFile(settingsPath, hookScriptPath) {
  return removeHookEntryFromFile(settingsPath, SESSION_START_EVENT, hookScriptPath);
}

function inspectSessionStartHookFile(settingsPath, hookScriptPath) {
  return inspectHookEntryFile(settingsPath, SESSION_START_EVENT, hookScriptPath);
}

function createSessionStartHookMergeOperation(targetRoot) {
  const hookScriptPath = resolveHookScriptDestination(targetRoot);
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: HOOK_MODULE_ID,
    sourceRelativePath: HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: resolveSettingsPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: SESSION_START_EVENT,
    hookScriptPath,
    hookCommand: buildSessionStartCommand(hookScriptPath),
  };
}

function hasStopHook(settings, hookScriptPath) {
  return hasHookEntry(settings, STOP_EVENT, hookScriptPath);
}

function addStopHook(settings, hookScriptPath) {
  return addHookEntry(settings, STOP_EVENT, hookScriptPath);
}

function removeStopHook(settings, hookScriptPath) {
  return removeHookEntry(settings, STOP_EVENT, hookScriptPath);
}

function applyStopHookToFile(settingsPath, hookScriptPath) {
  return applyHookEntryToFile(settingsPath, STOP_EVENT, hookScriptPath);
}

function removeStopHookFromFile(settingsPath, hookScriptPath) {
  return removeHookEntryFromFile(settingsPath, STOP_EVENT, hookScriptPath);
}

function inspectStopHookFile(settingsPath, hookScriptPath) {
  return inspectHookEntryFile(settingsPath, STOP_EVENT, hookScriptPath);
}

function createStopHookMergeOperation(targetRoot) {
  const hookScriptPath = resolveStopHookScriptDestination(targetRoot);
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: STOP_HOOK_MODULE_ID,
    sourceRelativePath: STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: resolveSettingsPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: STOP_EVENT,
    hookScriptPath,
    hookCommand: buildStopCommand(hookScriptPath),
  };
}

function resolveIntuitionHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'prompt-intuition.js');
}

function hasIntuitionHook(settings, hookScriptPath) {
  return hasHookEntry(settings, USER_PROMPT_SUBMIT_EVENT, hookScriptPath);
}

function addIntuitionHook(settings, hookScriptPath) {
  return addHookEntry(settings, USER_PROMPT_SUBMIT_EVENT, hookScriptPath);
}

function removeIntuitionHook(settings, hookScriptPath) {
  return removeHookEntry(settings, USER_PROMPT_SUBMIT_EVENT, hookScriptPath);
}

function applyIntuitionHookToFile(settingsPath, hookScriptPath) {
  return applyHookEntryToFile(settingsPath, USER_PROMPT_SUBMIT_EVENT, hookScriptPath);
}

function removeIntuitionHookFromFile(settingsPath, hookScriptPath) {
  return removeHookEntryFromFile(settingsPath, USER_PROMPT_SUBMIT_EVENT, hookScriptPath);
}

function inspectIntuitionHookFile(settingsPath, hookScriptPath) {
  return inspectHookEntryFile(settingsPath, USER_PROMPT_SUBMIT_EVENT, hookScriptPath);
}

function createUserPromptSubmitHookMergeOperation(targetRoot) {
  const hookScriptPath = resolveIntuitionHookScriptDestination(targetRoot);
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: INTUITION_HOOK_MODULE_ID,
    sourceRelativePath: INTUITION_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: resolveSettingsPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: USER_PROMPT_SUBMIT_EVENT,
    hookScriptPath,
    hookCommand: buildHookCommand(hookScriptPath),
  };
}

function resolveRouterHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'prompt-router.js');
}

function hasRouterHook(settings, hookScriptPath) {
  return hasHookEntry(settings, USER_PROMPT_SUBMIT_EVENT, hookScriptPath);
}

function addRouterHook(settings, hookScriptPath) {
  return addHookEntry(settings, USER_PROMPT_SUBMIT_EVENT, hookScriptPath);
}

function removeRouterHook(settings, hookScriptPath) {
  return removeHookEntry(settings, USER_PROMPT_SUBMIT_EVENT, hookScriptPath);
}

function applyRouterHookToFile(settingsPath, hookScriptPath) {
  return applyHookEntryToFile(settingsPath, USER_PROMPT_SUBMIT_EVENT, hookScriptPath);
}

function removeRouterHookFromFile(settingsPath, hookScriptPath) {
  return removeHookEntryFromFile(settingsPath, USER_PROMPT_SUBMIT_EVENT, hookScriptPath);
}

function inspectRouterHookFile(settingsPath, hookScriptPath) {
  return inspectHookEntryFile(settingsPath, USER_PROMPT_SUBMIT_EVENT, hookScriptPath);
}

function createUserPromptSubmitRouterHookMergeOperation(targetRoot) {
  const hookScriptPath = resolveRouterHookScriptDestination(targetRoot);
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: ROUTER_HOOK_MODULE_ID,
    sourceRelativePath: ROUTER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: resolveSettingsPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: USER_PROMPT_SUBMIT_EVENT,
    hookScriptPath,
    hookCommand: buildHookCommand(hookScriptPath),
  };
}

function resolveBashDispatcherHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'bash-hook-dispatcher.js');
}

function hasBashDispatcherHook(settings, hookScriptPath) {
  return hasHookEntry(settings, PRE_TOOL_USE_EVENT, hookScriptPath);
}

function addBashDispatcherHook(settings, hookScriptPath) {
  return addHookEntry(settings, PRE_TOOL_USE_EVENT, hookScriptPath, { matcher: 'Bash' });
}

function removeBashDispatcherHook(settings, hookScriptPath) {
  return removeHookEntry(settings, PRE_TOOL_USE_EVENT, hookScriptPath);
}

function applyBashDispatcherHookToFile(settingsPath, hookScriptPath) {
  return applyHookEntryToFile(settingsPath, PRE_TOOL_USE_EVENT, hookScriptPath, { matcher: 'Bash' });
}

function removeBashDispatcherHookFromFile(settingsPath, hookScriptPath) {
  return removeHookEntryFromFile(settingsPath, PRE_TOOL_USE_EVENT, hookScriptPath);
}

function inspectBashDispatcherHookFile(settingsPath, hookScriptPath) {
  return inspectHookEntryFile(settingsPath, PRE_TOOL_USE_EVENT, hookScriptPath);
}

function buildPreToolUseMergeOperation(targetRoot, moduleId, sourceRelativePath, hookScriptPath, matcher) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId,
    sourceRelativePath,
    destinationPath: resolveSettingsPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_TOOL_USE_EVENT,
    hookMatcher: matcher,
    hookScriptPath,
  };
}

function createPreToolUseBashDispatcherHookMergeOperation(targetRoot) {
  const hookScriptPath = resolveBashDispatcherHookScriptDestination(targetRoot);
  return buildPreToolUseMergeOperation(
    targetRoot,
    BASH_DISPATCHER_HOOK_MODULE_ID,
    BASH_DISPATCHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    hookScriptPath,
    'Bash'
  );
}

function resolveWriteValidatorHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'pre-write-guardian-validate.js');
}

function hasWriteValidatorHook(settings, hookScriptPath, matcher) {
  return hasHookEntry(settings, PRE_TOOL_USE_EVENT, hookScriptPath, matcher);
}

function addWriteValidatorHook(settings, hookScriptPath, matcher) {
  return addHookEntry(settings, PRE_TOOL_USE_EVENT, hookScriptPath, { matcher });
}

function removeWriteValidatorHook(settings, hookScriptPath) {
  return removeHookEntry(settings, PRE_TOOL_USE_EVENT, hookScriptPath);
}

function applyWriteValidatorHookToFile(settingsPath, hookScriptPath, matcher) {
  return applyHookEntryToFile(settingsPath, PRE_TOOL_USE_EVENT, hookScriptPath, { matcher });
}

function removeWriteValidatorHookFromFile(settingsPath, hookScriptPath) {
  return removeHookEntryFromFile(settingsPath, PRE_TOOL_USE_EVENT, hookScriptPath);
}

function inspectWriteValidatorHookFile(settingsPath, hookScriptPath, matcher) {
  return inspectHookEntryFile(settingsPath, PRE_TOOL_USE_EVENT, hookScriptPath, matcher);
}

function createPreToolUseWriteValidatorHookMergeOperation(targetRoot, matcher) {
  const hookScriptPath = resolveWriteValidatorHookScriptDestination(targetRoot);
  return buildPreToolUseMergeOperation(
    targetRoot,
    WRITE_VALIDATOR_HOOK_MODULE_ID,
    WRITE_VALIDATOR_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    hookScriptPath,
    matcher
  );
}

// EGC Scrubber: registered as its own PreToolUse entry (alongside, not instead
// of, the write validator above) so Edit/Write/MultiEdit content is cleaned of
// invisible-Unicode carriers and long dashes before it reaches disk. Fail-open.
// The script ships with the hooks runtime; see scripts/hooks/scrubber-hook.js.
function resolveScrubberHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'scrubber-hook.js');
}

function createPreToolUseScrubberHookMergeOperation(targetRoot, matcher) {
  const hookScriptPath = resolveScrubberHookScriptDestination(targetRoot);
  return buildPreToolUseMergeOperation(
    targetRoot,
    SCRUBBER_HOOK_MODULE_ID,
    SCRUBBER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    hookScriptPath,
    matcher
  );
}

// GateGuard fact-forcing gate: registered as its own PreToolUse entry
// (alongside, not instead of, the write validator above) so Edit/Write/
// MultiEdit get the same investigation gate that Bash already gets via
// bash-hook-dispatcher.js. See scripts/hooks/gateguard-fact-force.js.
function resolveGateGuardHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'gateguard-fact-force.js');
}

function hasGateGuardHook(settings, hookScriptPath, matcher) {
  return hasHookEntry(settings, PRE_TOOL_USE_EVENT, hookScriptPath, matcher);
}

function addGateGuardHook(settings, hookScriptPath, matcher) {
  return addHookEntry(settings, PRE_TOOL_USE_EVENT, hookScriptPath, { matcher });
}

function removeGateGuardHook(settings, hookScriptPath) {
  return removeHookEntry(settings, PRE_TOOL_USE_EVENT, hookScriptPath);
}

function applyGateGuardHookToFile(settingsPath, hookScriptPath, matcher) {
  return applyHookEntryToFile(settingsPath, PRE_TOOL_USE_EVENT, hookScriptPath, { matcher });
}

function removeGateGuardHookFromFile(settingsPath, hookScriptPath) {
  return removeHookEntryFromFile(settingsPath, PRE_TOOL_USE_EVENT, hookScriptPath);
}

function inspectGateGuardHookFile(settingsPath, hookScriptPath, matcher) {
  return inspectHookEntryFile(settingsPath, PRE_TOOL_USE_EVENT, hookScriptPath, matcher);
}

function createPreToolUseGateGuardHookMergeOperation(targetRoot, matcher) {
  const hookScriptPath = resolveGateGuardHookScriptDestination(targetRoot);
  return buildPreToolUseMergeOperation(
    targetRoot,
    GATEGUARD_HOOK_MODULE_ID,
    GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    hookScriptPath,
    matcher
  );
}

// gateguard-fact-force.js requires '../lib/utils' resolved relative to itself,
// so any target that wires the gate outside the generic module-scaffold path
// copies both files together; its other helpers (shell-split.js and
// wrapper-options.js) are among the Bash guardian's, which every such target
// also copies (BASH_GUARDIAN_HOOK_LIB_SOURCES).
const GATEGUARD_LIB_SOURCE_RELATIVE_PATH = 'scripts/lib/utils.js';

/**
 * Builds copy operations that place gateguard-fact-force.js (and its one
 * dependency) under `<targetRoot>/scripts/hooks/` and `<targetRoot>/scripts/lib/`,
 * unconditionally (independent of module selection). Used by install targets
 * whose own root does not already receive the shared "hooks-runtime" module
 * scaffold (Codex, Devin Desktop) or that want the gate guaranteed regardless of
 * profile (Continue).
 *
 * @param {(moduleId: string, sourceRelativePath: string, destinationPath: string, options?: object) => object} createRemappedOperation
 * @param {string} targetRoot
 * @returns {object[]}
 */
function createGateGuardScriptCopyOperations(createRemappedOperation, targetRoot) {
  return [
    createRemappedOperation(
      GATEGUARD_HOOK_MODULE_ID,
      GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveGateGuardHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    createRemappedOperation(
      GATEGUARD_HOOK_MODULE_ID,
      GATEGUARD_LIB_SOURCE_RELATIVE_PATH,
      path.join(targetRoot, 'scripts', 'lib', 'utils.js'),
      { strategy: 'preserve-relative-path' }
    ),
    createRemappedOperation(
      GATEGUARD_HOOK_MODULE_ID,
      'scripts/lib/hook-stdin.js',
      path.join(targetRoot, 'scripts', 'lib', 'hook-stdin.js'),
      { strategy: 'preserve-relative-path' }
    ),
  ];
}

module.exports = {
  GATEGUARD_LIB_SOURCE_RELATIVE_PATH,
  addBashDispatcherHook,
  addGateGuardHook,
  addIntuitionHook,
  addRouterHook,
  addSessionStartHook,
  addStopHook,
  addWriteValidatorHook,
  applyBashDispatcherHookToFile,
  applyGateGuardHookToFile,
  applyIntuitionHookToFile,
  applyRouterHookToFile,
  applySessionStartHookToFile,
  applyStopHookToFile,
  applyWriteValidatorHookToFile,
  createPreToolUseBashDispatcherHookMergeOperation,
  createGateGuardScriptCopyOperations,
  createPreToolUseGateGuardHookMergeOperation,
  createPreToolUseWriteValidatorHookMergeOperation,
  createPreToolUseScrubberHookMergeOperation,
  createSessionStartHookMergeOperation,
  createStopHookMergeOperation,
  createUserPromptSubmitHookMergeOperation,
  createUserPromptSubmitRouterHookMergeOperation,
  hasBashDispatcherHook,
  hasGateGuardHook,
  hasIntuitionHook,
  hasRouterHook,
  hasSessionStartHook,
  hasStopHook,
  hasWriteValidatorHook,
  inspectBashDispatcherHookFile,
  inspectGateGuardHookFile,
  inspectIntuitionHookFile,
  inspectRouterHookFile,
  inspectSessionStartHookFile,
  inspectStopHookFile,
  inspectWriteValidatorHookFile,
  removeBashDispatcherHook,
  removeBashDispatcherHookFromFile,
  removeGateGuardHook,
  removeGateGuardHookFromFile,
  removeIntuitionHook,
  removeIntuitionHookFromFile,
  removeRouterHook,
  removeRouterHookFromFile,
  removeSessionStartHook,
  removeSessionStartHookFromFile,
  removeStopHook,
  removeStopHookFromFile,
  removeWriteValidatorHook,
  removeWriteValidatorHookFromFile,
  resolveBashDispatcherHookScriptDestination,
  resolveGateGuardHookScriptDestination,
  resolveIntuitionHookScriptDestination,
  resolveRouterHookScriptDestination,
  resolveWriteValidatorHookScriptDestination,
  buildPreToolUseMergeOperation,
  resolveScrubberHookScriptDestination,
};
