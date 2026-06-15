'use strict';

// Manages EGC hook entries inside Claude Code settings.json.
// All merges are additive and idempotent: third-party hooks and unrelated
// settings keys are always preserved, and the EGC entry is identified by the
// installed hook script path so uninstall removes only what EGC added.

const fs = require('fs');
const path = require('path');

const SESSION_START_EVENT = 'SessionStart';
const STOP_EVENT = 'Stop';
const HOOK_OPERATION_KIND = 'merge-claude-settings-hooks';
const HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/claude-session-start.js';
const HOOK_MODULE_ID = 'claude-session-state-hook';
const STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/claude-session-stop.js';
const STOP_HOOK_MODULE_ID = 'claude-session-stop-hook';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildHookCommand(hookScriptPath) {
  return `node "${hookScriptPath}"`;
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

function matcherGroupHasEgcEntry(group, hookScriptPath) {
  return (
    isPlainObject(group)
    && Array.isArray(group.hooks)
    && group.hooks.some(entry => isEgcHookEntry(entry, hookScriptPath))
  );
}

function hasHookEntry(settings, event, hookScriptPath) {
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) {
    return false;
  }
  const groups = settings.hooks[event];
  return Array.isArray(groups)
    && groups.some(group => matcherGroupHasEgcEntry(group, hookScriptPath));
}

function addHookEntry(settings, event, hookScriptPath) {
  const base = isPlainObject(settings) ? settings : {};
  if (hasHookEntry(base, event, hookScriptPath)) {
    return { settings: base, changed: false };
  }
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};
  const groups = Array.isArray(hooks[event]) ? hooks[event].slice() : [];
  groups.push({ hooks: [{ type: 'command', command: buildHookCommand(hookScriptPath) }] });
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

function applyHookEntryToFile(settingsPath, event, hookScriptPath) {
  const current = readSettingsFile(settingsPath);
  const { settings, changed } = addHookEntry(current, event, hookScriptPath);
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

function inspectHookEntryFile(settingsPath, event, hookScriptPath) {
  try {
    return hasHookEntry(readSettingsFile(settingsPath), event, hookScriptPath)
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

module.exports = {
  HOOK_MODULE_ID,
  HOOK_OPERATION_KIND,
  HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  SESSION_START_EVENT,
  STOP_EVENT,
  STOP_HOOK_MODULE_ID,
  STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  addSessionStartHook,
  addStopHook,
  applySessionStartHookToFile,
  applyStopHookToFile,
  buildSessionStartCommand,
  buildStopCommand,
  createSessionStartHookMergeOperation,
  createStopHookMergeOperation,
  hasSessionStartHook,
  hasStopHook,
  inspectSessionStartHookFile,
  inspectStopHookFile,
  readSettingsFile,
  removeSessionStartHook,
  removeSessionStartHookFromFile,
  removeStopHook,
  removeStopHookFromFile,
  resolveHookScriptDestination,
  resolveSettingsPath,
  resolveStopHookScriptDestination,
};
