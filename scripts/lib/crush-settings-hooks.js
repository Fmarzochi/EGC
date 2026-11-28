'use strict';

// Manages EGC hook entries inside Charmbracelet Crush's crush.json config:
// the Guardian and the Token Crusher on PreToolUse, the session start on
// SessionStart and the Team Brain push on TurnEnd. Crush expects a flat
// {hooks: {<event>: [{matcher, command}]}} JSON shape, without Claude
// Code's nested "hooks: [{type: 'command', command}]" wrapper; a tool event
// carries a matcher, a session event none. Crush reads nothing back from
// SessionStart (the session reads the memory through get_state) and
// nothing the push answers on TurnEnd.

const path = require('node:path');
const {
  buildHookCommand,
  isPlainObject,
  isStaleEgcEntry,
  readFlatHooksFile,
  removeFlatHookEntry,
  removeFlatHookFromFile,
  writeFlatHooksFile,
} = require('./flat-hooks-json-merge');
const BASH_GUARDIAN_HOOK_MODULE_ID = 'egc-bash-guardian-hook';
const CRUSHER_HOOK_MODULE_ID = 'egc-crusher-hook';
const CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/crusher-hook.js';
const HOOK_OPERATION_KIND = 'merge-claude-settings-hooks';

const HOST_LABEL = 'Crush';
const PRE_TOOL_USE_EVENT = 'PreToolUse';
const SESSION_START_EVENT = 'SessionStart';
const TURN_END_EVENT = 'TurnEnd';
// The operation events: the event of crush.json behind a crush: prefix,
// which keeps them apart from the Claude Code events in the dispatch table.
const CRUSH_EVENT_PREFIX = 'crush:';
const CRUSH_PRE_TOOL_USE_EVENT = `${CRUSH_EVENT_PREFIX}${PRE_TOOL_USE_EVENT}`;
const CRUSH_SESSION_START_EVENT = `${CRUSH_EVENT_PREFIX}${SESSION_START_EVENT}`;
const CRUSH_TURN_END_EVENT = `${CRUSH_EVENT_PREFIX}${TURN_END_EVENT}`;
const GUARDIAN_MATCHER = '^(bash|edit|write|multiedit)$';
const CRUSHER_MATCHER = '^bash$';
const CRUSH_CONFIG_FILE_NAME = 'crush.json';
const GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/crush-guardian-adapter.js';
const CRUSH_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/crush-session-start.js';
const TEAM_SYNC_STOP_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/team-sync-stop.js';
const EGC_GUARDIAN_ADAPTER_BASENAME = path.basename(GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);
const EGC_CRUSHER_BASENAME = 'crusher-hook.js';
const EGC_SCRIPT_BASENAMES = Object.freeze([
  EGC_GUARDIAN_ADAPTER_BASENAME,
  EGC_CRUSHER_BASENAME,
  path.basename(CRUSH_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH),
  path.basename(TEAM_SYNC_STOP_SCRIPT_SOURCE_RELATIVE_PATH),
]);

/**
 * The event of crush.json an operation event stands for.
 * @param {string} hookEvent
 * @returns {string}
 */
function crushNativeEvent(hookEvent) {
  return hookEvent.startsWith(CRUSH_EVENT_PREFIX) ? hookEvent.slice(CRUSH_EVENT_PREFIX.length) : hookEvent;
}

/**
 * Checks if a hook command runs one of the EGC scripts, so an entry left by
 * an older install location is replaced instead of doubled.
 * @param {string} command
 * @returns {boolean}
 */
function isOwnBasename(command) {
  return EGC_SCRIPT_BASENAMES.some(basename => command.includes(basename));
}

/**
 * Resolves the path to the crush.json config file within targetRoot.
 * @param {string} targetRoot
 * @returns {string}
 */
function resolveCrushHooksJsonPath(targetRoot) {
  return path.join(targetRoot, CRUSH_CONFIG_FILE_NAME);
}

/**
 * Resolves the destination path for the crush-guardian-adapter.js script within targetRoot.
 * @param {string} targetRoot
 * @returns {string}
 */
function resolveCrushGuardianAdapterDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'crush-guardian-adapter.js');
}

/**
 * Adds or updates a hook entry in the Crush configuration object.
 * @param {Record<string, unknown>} config
 * @param {string} event
 * @param {string} command
 * @param {string} [matcher]
 * @returns {{config: Record<string, unknown>, changed: boolean}}
 */
function addCrushHookEntry(config, event, command, matcher) {
  const base = isPlainObject(config) ? config : {};
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};
  const existing = Array.isArray(hooks[event]) ? hooks[event] : [];

  if (existing.some(entry => isPlainObject(entry) && entry.command === command && (!matcher || entry.matcher === matcher))) {
    return { config: base, changed: false };
  }

  const extraFields = matcher ? { matcher } : {};
  let migrated = false;
  const nextEntries = existing.map(entry => {
    if (!migrated && isStaleEgcEntry(entry, command, isOwnBasename)) {
      migrated = true;
      return { ...entry, ...extraFields, command };
    }
    if (!migrated && isPlainObject(entry) && entry.command === command) {
      migrated = true;
      return { ...entry, ...extraFields, command };
    }
    return entry;
  });

  if (!migrated) {
    nextEntries.push({ ...extraFields, command });
  }

  hooks[event] = nextEntries;
  return { config: { ...base, hooks }, changed: true };
}

/**
 * Removes a hook entry from a Crush configuration object.
 * @param {Record<string, unknown>} config
 * @param {string} event
 * @param {string} command
 * @returns {{config: Record<string, unknown>, changed: boolean}}
 */
function removeCrushHookEntry(config, event, command) {
  return removeFlatHookEntry(config, event, command);
}

/**
 * Applies a Crush hook command and matcher to a configuration file on disk,
 * under the given event of crush.json (PreToolUse by default).
 * @param {string} hooksJsonPath
 * @param {string} hookScriptPath
 * @param {string} [matcher]
 * @param {string} [event]
 * @returns {{changed: boolean}}
 */
function applyCrushHookToFile(hooksJsonPath, hookScriptPath, matcher, event = PRE_TOOL_USE_EVENT) {
  const command = buildHookCommand(hookScriptPath);
  const current = readFlatHooksFile(hooksJsonPath, HOST_LABEL);
  const { config, changed } = addCrushHookEntry(current, event, command, matcher);
  if (changed) {
    writeFlatHooksFile(hooksJsonPath, config);
  }
  return { changed };
}

/**
 * Removes a Crush hook from a configuration file on disk.
 * @param {string} hooksJsonPath
 * @param {string} hookScriptPath
 * @param {string} [event]
 * @returns {{changed: boolean}}
 */
function removeCrushHookFromFile(hooksJsonPath, hookScriptPath, event = PRE_TOOL_USE_EVENT) {
  const command = buildHookCommand(hookScriptPath);
  return removeFlatHookFromFile(hooksJsonPath, HOST_LABEL, event, command);
}

/**
 * Inspects a Crush hook configuration file to verify if a hook is present and configured.
 * @param {string} hooksJsonPath
 * @param {string} hookScriptPath
 * @param {string} [matcher]
 * @param {string} [event]
 * @returns {'ok'|'drifted'}
 */
function inspectCrushHookFile(hooksJsonPath, hookScriptPath, matcher, event = PRE_TOOL_USE_EVENT) {
  try {
    const current = readFlatHooksFile(hooksJsonPath, HOST_LABEL);
    const hooks = isPlainObject(current.hooks) ? current.hooks : {};
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const command = buildHookCommand(hookScriptPath);
    const found = existing.some(entry => (
      isPlainObject(entry)
      && entry.command === command
      && (matcher === undefined || entry.matcher === matcher)
    ));
    return found ? 'ok' : 'drifted';
  } catch {
    return 'drifted';
  }
}

// The handlers claude-settings-hook-handlers.js dispatches a
// crush:PreToolUse, crush:SessionStart or crush:TurnEnd operation to.
const CRUSH_HOOK_OPERATION_HANDLERS = Object.freeze({
  apply: operation => applyCrushHookToFile(operation.destinationPath, operation.hookScriptPath, operation.hookMatcher, crushNativeEvent(operation.hookEvent)),
  remove: operation => removeCrushHookFromFile(operation.destinationPath, operation.hookScriptPath, crushNativeEvent(operation.hookEvent)),
  inspect: operation => inspectCrushHookFile(operation.destinationPath, operation.hookScriptPath, operation.hookMatcher, crushNativeEvent(operation.hookEvent)),
});

/**
 * Creates the Guardian PreToolUse hook merge operation for Crush.
 * @param {string} targetRoot
 * @returns {object}
 */
function createCrushGuardianHookMergeOperation(targetRoot) {
  const destinationPath = resolveCrushHooksJsonPath(targetRoot);
  const hookScriptPath = resolveCrushGuardianAdapterDestination(targetRoot);
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: BASH_GUARDIAN_HOOK_MODULE_ID,
    sourceRelativePath: GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: CRUSH_PRE_TOOL_USE_EVENT,
    hookMatcher: GUARDIAN_MATCHER,
    hookScriptPath,
  };
}

/**
 * Creates the Crusher PreToolUse hook merge operation for Crush.
 * @param {string} targetRoot
 * @returns {object}
 */
function createCrushCrusherHookMergeOperation(targetRoot) {
  const { resolveCrusherHookScriptDestination } = require('./claude-settings-hooks');
  const destinationPath = resolveCrushHooksJsonPath(targetRoot);
  const hookScriptPath = resolveCrusherHookScriptDestination(targetRoot);
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: CRUSHER_HOOK_MODULE_ID,
    sourceRelativePath: CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: CRUSH_PRE_TOOL_USE_EVENT,
    hookMatcher: CRUSHER_MATCHER,
    hookScriptPath,
  };
}

/**
 * The two session entries of crush.json under targetRoot: SessionStart runs
 * the Crush wrapper of the shared host session start (the pull and the
 * restore), TurnEnd runs the shared Team Brain push after each response.
 * Neither takes a matcher.
 * @param {string} targetRoot
 * @returns {Array<object>}
 */
function createCrushSessionHookMergeOperations(targetRoot) {
  const { HOST_SESSION_HOOK_MODULE_ID, resolveTeamSyncStopHookScriptDestination } = require('./claude-settings-hook-copy-operations');
  const destinationPath = resolveCrushHooksJsonPath(targetRoot);
  const entry = (sourceRelativePath, hookEvent, hookScriptPath) => ({
    kind: HOOK_OPERATION_KIND,
    moduleId: HOST_SESSION_HOOK_MODULE_ID,
    sourceRelativePath,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent,
    hookScriptPath,
  });
  return [
    entry(CRUSH_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH, CRUSH_SESSION_START_EVENT, path.join(targetRoot, ...CRUSH_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH.split('/'))),
    entry(TEAM_SYNC_STOP_SCRIPT_SOURCE_RELATIVE_PATH, CRUSH_TURN_END_EVENT, resolveTeamSyncStopHookScriptDestination(targetRoot)),
  ];
}

/**
 * Creates operations to copy Guardian support scripts into targetRoot.
 * @param {Function} createRemappedOperation
 * @param {string} targetRoot
 * @returns {Array<object>}
 */
function createCrushGuardianScriptCopyOperations(createRemappedOperation, targetRoot) {
  const {
    createAdapterStdinJsonCopyOperation,
    createBashGuardianScriptCopyOperations,
    createWriteValidatorScriptCopyOperation,
  } = require('./claude-settings-hooks');
  return [
    ...createBashGuardianScriptCopyOperations(createRemappedOperation, targetRoot),
    createWriteValidatorScriptCopyOperation(createRemappedOperation, targetRoot),
    createAdapterStdinJsonCopyOperation(createRemappedOperation, targetRoot),
    createRemappedOperation(
      BASH_GUARDIAN_HOOK_MODULE_ID,
      GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveCrushGuardianAdapterDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
  ];
}

module.exports = {
  CRUSH_CONFIG_FILE_NAME,
  CRUSH_CRUSHER_MATCHER: CRUSHER_MATCHER,
  CRUSH_GUARDIAN_MATCHER: GUARDIAN_MATCHER,
  CRUSH_HOOK_OPERATION_HANDLERS,
  CRUSH_PRE_TOOL_USE_EVENT,
  CRUSH_SESSION_START_EVENT,
  CRUSH_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH,
  CRUSH_TURN_END_EVENT,
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_TOOL_USE_EVENT,
  SESSION_START_EVENT,
  TURN_END_EVENT,
  addCrushHookEntry,
  applyCrushHookToFile,
  createCrushCrusherHookMergeOperation,
  createCrushGuardianHookMergeOperation,
  createCrushGuardianScriptCopyOperations,
  createCrushSessionHookMergeOperations,
  crushNativeEvent,
  inspectCrushHookFile,
  removeCrushHookEntry,
  removeCrushHookFromFile,
  resolveCrushGuardianAdapterDestination,
  resolveCrushHooksJsonPath,
};
