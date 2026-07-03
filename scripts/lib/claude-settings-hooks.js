'use strict';

// Manages EGC hook entries inside Claude Code settings.json.
// All merges are additive and idempotent: third-party hooks and unrelated
// settings keys are always preserved, and the EGC entry is identified by the
// installed hook script path so uninstall removes only what EGC added.

const fs = require('fs');
const path = require('path');

const SESSION_START_EVENT = 'SessionStart';
const STOP_EVENT = 'Stop';
const USER_PROMPT_SUBMIT_EVENT = 'UserPromptSubmit';
const PRE_TOOL_USE_EVENT = 'PreToolUse';
const HOOK_OPERATION_KIND = 'merge-claude-settings-hooks';
const HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/claude-session-start.js';
const HOOK_MODULE_ID = 'claude-session-state-hook';
const STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/claude-session-stop.js';
const STOP_HOOK_MODULE_ID = 'claude-session-stop-hook';
const INTUITION_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/prompt-intuition.js';
const INTUITION_HOOK_MODULE_ID = 'claude-intuition-hook';
const BASH_DISPATCHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/bash-hook-dispatcher.js';
const BASH_DISPATCHER_HOOK_MODULE_ID = 'claude-bash-dispatcher-hook';
const WRITE_VALIDATOR_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/pre-write-guardian-validate.js';
const WRITE_VALIDATOR_HOOK_MODULE_ID = 'claude-write-validator-hook';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildHookCommand(hookScriptPath) {
  return `"${process.execPath}" "${hookScriptPath}"`; // NOSONAR jssecurity:S8705
}

function buildSessionStartCommand(hookScriptPath) {
  return buildHookCommand(hookScriptPath);
}

function buildStopCommand(hookScriptPath) {
  return buildHookCommand(hookScriptPath);
}

function resolveHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'egc', 'hooks', 'claude-session-start.js');
}

function resolveStopHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'egc', 'hooks', 'claude-session-stop.js');
}

function resolveSettingsPath(targetRoot) {
  return path.join(targetRoot, 'settings.json');
}

function isEgcHookEntry(entry, hookScriptPath) {
  return (
    isPlainObject(entry)
    && typeof entry.command === 'string'
    && entry.command.includes(hookScriptPath)
  );
}

function matcherGroupHasEgcEntry(group, hookScriptPath, matcherFilter) {
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) return false;
  if (matcherFilter !== undefined && group.matcher !== matcherFilter) return false;
  return group.hooks.some(entry => isEgcHookEntry(entry, hookScriptPath));
}

function hasHookEntry(settings, event, hookScriptPath, matcherFilter) {
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) {
    return false;
  }
  const groups = settings.hooks[event];
  return Array.isArray(groups)
    && groups.some(group => matcherGroupHasEgcEntry(group, hookScriptPath, matcherFilter));
}

function addHookEntry(settings, event, hookScriptPath, options = {}) {
  const base = isPlainObject(settings) ? settings : {};
  const matcher = typeof options.matcher === 'string' && options.matcher ? options.matcher : undefined;
  if (hasHookEntry(base, event, hookScriptPath, matcher)) {
    return { settings: base, changed: false };
  }
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};
  const groups = Array.isArray(hooks[event]) ? hooks[event].slice() : [];
  const group = { hooks: [{ type: 'command', command: buildHookCommand(hookScriptPath) }] };
  if (matcher) {
    group.matcher = matcher;
  }
  groups.push(group);
  hooks[event] = groups;
  return { settings: { ...base, hooks }, changed: true };
}

function removeHookEntry(settings, event, hookScriptPath) {
  if (
    !isPlainObject(settings)
    || !isPlainObject(settings.hooks)
    || !Array.isArray(settings.hooks[event])
  ) {
    return { settings, changed: false };
  }

  let changed = false;
  const groups = [];

  for (const group of settings.hooks[event]) {
    if (!matcherGroupHasEgcEntry(group, hookScriptPath)) {
      groups.push(group);
      continue;
    }
    changed = true;
    const remainingEntries = group.hooks.filter(
      entry => !isEgcHookEntry(entry, hookScriptPath)
    );
    if (remainingEntries.length > 0) {
      groups.push({ ...group, hooks: remainingEntries });
    }
  }

  if (!changed) {
    return { settings, changed: false };
  }

  const hooks = { ...settings.hooks };
  if (groups.length > 0) {
    hooks[event] = groups;
  } else {
    delete hooks[event];
  }

  const next = { ...settings };
  if (Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  } else {
    delete next.hooks;
  }

  return { settings: next, changed: true };
}

function readSettingsFile(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  const raw = fs.readFileSync(settingsPath, 'utf8');
  if (!raw.trim()) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse Claude Code settings at ${settingsPath}: ${error.message}`,
      { cause: error }
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `Invalid Claude Code settings at ${settingsPath}: expected a JSON object`
    );
  }

  return parsed;
}

function writeSettingsFile(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function applyHookEntryToFile(settingsPath, event, hookScriptPath, options = {}) {
  const current = readSettingsFile(settingsPath);
  const { settings, changed } = addHookEntry(current, event, hookScriptPath, options);
  if (changed) {
    writeSettingsFile(settingsPath, settings);
  }
  return { changed };
}

function removeHookEntryFromFile(settingsPath, event, hookScriptPath) {
  if (!fs.existsSync(settingsPath)) {
    return { changed: false };
  }
  const current = readSettingsFile(settingsPath);
  const { settings, changed } = removeHookEntry(current, event, hookScriptPath);
  if (changed) {
    writeSettingsFile(settingsPath, settings);
  }
  return { changed };
}

function inspectHookEntryFile(settingsPath, event, hookScriptPath, matcherFilter) {
  try {
    return hasHookEntry(readSettingsFile(settingsPath), event, hookScriptPath, matcherFilter)
      ? 'ok'
      : 'drifted';
  } catch {
    return 'drifted';
  }
}

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

module.exports = {
  BASH_DISPATCHER_HOOK_MODULE_ID,
  BASH_DISPATCHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  HOOK_MODULE_ID,
  HOOK_OPERATION_KIND,
  HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  INTUITION_HOOK_MODULE_ID,
  INTUITION_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_TOOL_USE_EVENT,
  SESSION_START_EVENT,
  STOP_EVENT,
  STOP_HOOK_MODULE_ID,
  STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  USER_PROMPT_SUBMIT_EVENT,
  WRITE_VALIDATOR_HOOK_MODULE_ID,
  WRITE_VALIDATOR_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  addBashDispatcherHook,
  addIntuitionHook,
  addSessionStartHook,
  addStopHook,
  addWriteValidatorHook,
  applyBashDispatcherHookToFile,
  applyHookEntryToFile,
  applyIntuitionHookToFile,
  applySessionStartHookToFile,
  applyStopHookToFile,
  applyWriteValidatorHookToFile,
  buildSessionStartCommand,
  buildStopCommand,
  createPreToolUseBashDispatcherHookMergeOperation,
  createPreToolUseWriteValidatorHookMergeOperation,
  createSessionStartHookMergeOperation,
  createStopHookMergeOperation,
  createUserPromptSubmitHookMergeOperation,
  hasBashDispatcherHook,
  hasIntuitionHook,
  hasSessionStartHook,
  hasStopHook,
  hasWriteValidatorHook,
  inspectBashDispatcherHookFile,
  inspectHookEntryFile,
  inspectIntuitionHookFile,
  inspectSessionStartHookFile,
  inspectStopHookFile,
  inspectWriteValidatorHookFile,
  readSettingsFile,
  removeBashDispatcherHook,
  removeBashDispatcherHookFromFile,
  removeHookEntryFromFile,
  removeIntuitionHook,
  removeIntuitionHookFromFile,
  removeSessionStartHook,
  removeSessionStartHookFromFile,
  removeStopHook,
  removeStopHookFromFile,
  removeWriteValidatorHook,
  removeWriteValidatorHookFromFile,
  resolveBashDispatcherHookScriptDestination,
  resolveHookScriptDestination,
  resolveIntuitionHookScriptDestination,
  resolveSettingsPath,
  resolveStopHookScriptDestination,
  resolveWriteValidatorHookScriptDestination,
};
