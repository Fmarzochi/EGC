'use strict';

// Manages the EGC SessionStart hook entry inside Claude Code settings.json.
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

function buildSessionStartCommand(hookScriptPath) {
  return `node "${hookScriptPath}"`;
}

function buildStopCommand(hookScriptPath) {
  return `node "${hookScriptPath}"`;
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

function hasSessionStartHook(settings, hookScriptPath) {
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) {
    return false;
  }

  const groups = settings.hooks[SESSION_START_EVENT];
  return Array.isArray(groups)
    && groups.some(group => matcherGroupHasEgcEntry(group, hookScriptPath));
}

function addSessionStartHook(settings, hookScriptPath) {
  const base = isPlainObject(settings) ? settings : {};

  if (hasSessionStartHook(base, hookScriptPath)) {
    return { settings: base, changed: false };
  }

  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};
  const groups = Array.isArray(hooks[SESSION_START_EVENT])
    ? hooks[SESSION_START_EVENT].slice()
    : [];

  groups.push({
    hooks: [
      {
        type: 'command',
        command: buildSessionStartCommand(hookScriptPath),
      },
    ],
  });
  hooks[SESSION_START_EVENT] = groups;

  return {
    settings: { ...base, hooks },
    changed: true,
  };
}

function removeSessionStartHook(settings, hookScriptPath) {
  if (
    !isPlainObject(settings)
    || !isPlainObject(settings.hooks)
    || !Array.isArray(settings.hooks[SESSION_START_EVENT])
  ) {
    return { settings, changed: false };
  }

  let changed = false;
  const groups = [];

  for (const group of settings.hooks[SESSION_START_EVENT]) {
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
    hooks[SESSION_START_EVENT] = groups;
  } else {
    delete hooks[SESSION_START_EVENT];
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

function applySessionStartHookToFile(settingsPath, hookScriptPath) {
  const current = readSettingsFile(settingsPath);
  const { settings, changed } = addSessionStartHook(current, hookScriptPath);

  if (changed) {
    writeSettingsFile(settingsPath, settings);
  }

  return { changed };
}

function removeSessionStartHookFromFile(settingsPath, hookScriptPath) {
  if (!fs.existsSync(settingsPath)) {
    return { changed: false };
  }

  const current = readSettingsFile(settingsPath);
  const { settings, changed } = removeSessionStartHook(current, hookScriptPath);

  if (changed) {
    writeSettingsFile(settingsPath, settings);
  }

  return { changed };
}

function inspectSessionStartHookFile(settingsPath, hookScriptPath) {
  try {
    return hasSessionStartHook(readSettingsFile(settingsPath), hookScriptPath)
      ? 'ok'
      : 'drifted';
  } catch (_error) {
    return 'drifted';
  }
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
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) {
    return false;
  }

  const groups = settings.hooks[STOP_EVENT];
  return Array.isArray(groups)
    && groups.some(group => matcherGroupHasEgcEntry(group, hookScriptPath));
}

function addStopHook(settings, hookScriptPath) {
  const base = isPlainObject(settings) ? settings : {};

  if (hasStopHook(base, hookScriptPath)) {
    return { settings: base, changed: false };
  }

  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};
  const groups = Array.isArray(hooks[STOP_EVENT]) ? hooks[STOP_EVENT].slice() : [];

  groups.push({
    hooks: [{ type: 'command', command: buildStopCommand(hookScriptPath) }],
  });
  hooks[STOP_EVENT] = groups;

  return { settings: { ...base, hooks }, changed: true };
}

function removeStopHook(settings, hookScriptPath) {
  if (
    !isPlainObject(settings)
    || !isPlainObject(settings.hooks)
    || !Array.isArray(settings.hooks[STOP_EVENT])
  ) {
    return { settings, changed: false };
  }

  let changed = false;
  const groups = [];

  for (const group of settings.hooks[STOP_EVENT]) {
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
    hooks[STOP_EVENT] = groups;
  } else {
    delete hooks[STOP_EVENT];
  }

  const next = { ...settings };
  if (Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  } else {
    delete next.hooks;
  }

  return { settings: next, changed: true };
}

function applyStopHookToFile(settingsPath, hookScriptPath) {
  const current = readSettingsFile(settingsPath);
  const { settings, changed } = addStopHook(current, hookScriptPath);

  if (changed) {
    writeSettingsFile(settingsPath, settings);
  }

  return { changed };
}

function removeStopHookFromFile(settingsPath, hookScriptPath) {
  if (!fs.existsSync(settingsPath)) {
    return { changed: false };
  }

  const current = readSettingsFile(settingsPath);
  const { settings, changed } = removeStopHook(current, hookScriptPath);

  if (changed) {
    writeSettingsFile(settingsPath, settings);
  }

  return { changed };
}

function inspectStopHookFile(settingsPath, hookScriptPath) {
  try {
    return hasStopHook(readSettingsFile(settingsPath), hookScriptPath) ? 'ok' : 'drifted';
  } catch (_error) {
    return 'drifted';
  }
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
