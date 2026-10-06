'use strict';

// Manages EGC hook entries inside Charmbracelet Crush's crush.json config.
// Crush expects a flat {hooks: {<event>: [{matcher, command}]}} JSON shape,
// without Claude Code's nested "hooks: [{type: 'command', command}]" wrapper.
// Upstream Crush PreToolUse hooks require a flat structure where each element
// has both "matcher" and "command" fields.

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
const CRUSH_PRE_TOOL_USE_EVENT = 'crush:PreToolUse';
const GUARDIAN_MATCHER = '^(bash|edit|write|multiedit)$';
const CRUSHER_MATCHER = '^bash$';
const CRUSH_CONFIG_FILE_NAME = 'crush.json';
const GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/crush-guardian-adapter.js';
const EGC_GUARDIAN_ADAPTER_BASENAME = path.basename(GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);
const EGC_CRUSHER_BASENAME = 'crusher-hook.js';

/**
 * Checks if a hook command contains our own adapter or crusher basename.
 * @param {string} command
 * @returns {boolean}
 */
function isOwnBasename(command) {
  return command.includes(EGC_GUARDIAN_ADAPTER_BASENAME) || command.includes(EGC_CRUSHER_BASENAME);
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
 * Applies a Crush hook command and matcher to a configuration file on disk.
 * @param {string} hooksJsonPath
 * @param {string} hookScriptPath
 * @param {string} [matcher]
 * @returns {{changed: boolean}}
 */
function applyCrushHookToFile(hooksJsonPath, hookScriptPath, matcher) {
  const command = buildHookCommand(hookScriptPath);
  const current = readFlatHooksFile(hooksJsonPath, HOST_LABEL);
  const { config, changed } = addCrushHookEntry(current, PRE_TOOL_USE_EVENT, command, matcher);
  if (changed) {
    writeFlatHooksFile(hooksJsonPath, config);
  }
  return { changed };
}

/**
 * Removes a Crush hook from a configuration file on disk.
 * @param {string} hooksJsonPath
 * @param {string} hookScriptPath
 * @returns {{changed: boolean}}
 */
function removeCrushHookFromFile(hooksJsonPath, hookScriptPath) {
  const command = buildHookCommand(hookScriptPath);
  return removeFlatHookFromFile(hooksJsonPath, HOST_LABEL, PRE_TOOL_USE_EVENT, command);
}

/**
 * Inspects a Crush hook configuration file to verify if a hook is present and configured.
 * @param {string} hooksJsonPath
 * @param {string} hookScriptPath
 * @param {string} [matcher]
 * @returns {'ok'|'drifted'}
 */
function inspectCrushHookFile(hooksJsonPath, hookScriptPath, matcher) {
  try {
    const current = readFlatHooksFile(hooksJsonPath, HOST_LABEL);
    const hooks = isPlainObject(current.hooks) ? current.hooks : {};
    const existing = Array.isArray(hooks[PRE_TOOL_USE_EVENT]) ? hooks[PRE_TOOL_USE_EVENT] : [];
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
 * Creates operations to copy Guardian and Crusher support scripts into targetRoot.
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
  CRUSH_PRE_TOOL_USE_EVENT,
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_TOOL_USE_EVENT,
  addCrushHookEntry,
  applyCrushHookToFile,
  createCrushCrusherHookMergeOperation,
  createCrushGuardianHookMergeOperation,
  createCrushGuardianScriptCopyOperations,
  inspectCrushHookFile,
  removeCrushHookEntry,
  removeCrushHookFromFile,
  resolveCrushGuardianAdapterDestination,
  resolveCrushHooksJsonPath,
};
