'use strict';

// Event names, module ids and the settings.json read/merge/remove/inspect primitives behind every Claude-schema hook entry.
// Part of the claude-settings-hooks.js split; that file re-exports the public surface.

const fs = require('node:fs');
const path = require('node:path');

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
const SCRUBBER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/scrubber-hook.js';
const SCRUBBER_HOOK_MODULE_ID = 'claude-scrubber-hook';
const ROUTER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/prompt-router.js';
const ROUTER_HOOK_MODULE_ID = 'claude-prompt-router-hook';
const GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/gateguard-fact-force.js';
const GATEGUARD_HOOK_MODULE_ID = 'claude-gateguard-fact-force-hook';
const BASH_GUARDIAN_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/pre-bash-guardian-validate.js';
const BASH_GUARDIAN_HOOK_MODULE_ID = 'egc-bash-guardian-hook';
const CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/crusher-hook.js';
const CRUSHER_HOOK_MODULE_ID = 'egc-crusher-hook';
const MESH_NOTICE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/mesh-events-inject.js';
const MESH_NOTICE_HOOK_MODULE_ID = 'egc-mesh-notice-hook';
const PRE_COMPACT_EVENT = 'PreCompact';
const POST_COMPACT_EVENT = 'PostCompact';
const EGC_MEMORY_SAVE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/egc-memory-save.js';
const EGC_MEMORY_SAVE_HOOK_MODULE_ID = 'egc-memory-save-hook';

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

function extractScriptBasename(command) {
  const scriptPaths = String(command).match(/[^\s"']+\.js\b/g); // NOSONAR: superlinear risk accepted: input is the local user's own command or CLI output
  if (!scriptPaths || scriptPaths.length === 0) {
    return null;
  }
  return path.basename(scriptPaths.at(-1));
}

function isStaleEgcHookEntry(entry, hookScriptPath) {
  if (!isPlainObject(entry) || typeof entry.command !== 'string') {
    return false;
  }
  if (entry.command.includes(hookScriptPath)) {
    return false;
  }
  return extractScriptBasename(entry.command) === path.basename(hookScriptPath);
}

function migrateStaleGroupEntries(group, hookScriptPath, alreadyPresent) {
  let present = alreadyPresent;
  let groupChanged = false;
  const entries = [];

  for (const entry of group.hooks) {
    if (!isStaleEgcHookEntry(entry, hookScriptPath)) {
      entries.push(entry);
      continue;
    }
    groupChanged = true;
    if (!present) {
      // Migrate in place so entry-level keys like statusMessage survive.
      entries.push({ ...entry, command: buildHookCommand(hookScriptPath) });
      present = true;
    }
  }

  return { entries, groupChanged, present };
}

function isMatcherGroup(group, matcher) {
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) return false;
  return matcher === undefined ? group?.matcher === undefined : group?.matcher === matcher;
}

function buildNewGroup(hookScriptPath, matcher) {
  const group = { hooks: [{ type: 'command', command: buildHookCommand(hookScriptPath) }] };
  if (matcher) group.matcher = matcher;
  return group;
}

function mergeMatcherGroups(existingGroups, matcher, hookScriptPath, initialPresent) {
  let present = initialPresent;
  let changed = false;
  const groups = [];

  for (const group of existingGroups) {
    if (!isMatcherGroup(group, matcher)) {
      groups.push(group);
      continue;
    }

    const migration = migrateStaleGroupEntries(group, hookScriptPath, present);
    present = migration.present;
    if (!migration.groupChanged) {
      groups.push(group);
    } else {
      changed = true;
      if (migration.entries.length > 0) {
        groups.push({ ...group, hooks: migration.entries });
      }
    }
  }

  return { groups, present, changed };
}

function addHookEntry(settings, event, hookScriptPath, options = {}) {
  const base = isPlainObject(settings) ? settings : {};
  const matcher = typeof options.matcher === 'string' && options.matcher ? options.matcher : undefined;
  const existingGroups = isPlainObject(base.hooks) && Array.isArray(base.hooks[event])
    ? base.hooks[event]
    : [];

  const merged = mergeMatcherGroups(existingGroups, matcher, hookScriptPath, hasHookEntry(base, event, hookScriptPath, matcher));
  const groups = merged.groups;
  let present = merged.present;
  let changed = merged.changed;

  if (!present) {
    groups.push(buildNewGroup(hookScriptPath, matcher));
    changed = true;
  }

  if (!changed) {
    return { settings: base, changed: false };
  }

  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};
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

module.exports = {
  BASH_DISPATCHER_HOOK_MODULE_ID,
  BASH_DISPATCHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  BASH_GUARDIAN_HOOK_MODULE_ID,
  BASH_GUARDIAN_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  GATEGUARD_HOOK_MODULE_ID,
  GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  CRUSHER_HOOK_MODULE_ID,
  CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_COMPACT_EVENT,
  POST_COMPACT_EVENT,
  EGC_MEMORY_SAVE_HOOK_MODULE_ID,
  EGC_MEMORY_SAVE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
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
  ROUTER_HOOK_MODULE_ID,
  ROUTER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  applyHookEntryToFile,
  buildHookCommand,
  buildSessionStartCommand,
  buildStopCommand,
  MESH_NOTICE_HOOK_MODULE_ID,
  MESH_NOTICE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  inspectHookEntryFile,
  readSettingsFile,
  removeHookEntryFromFile,
  resolveHookScriptDestination,
  resolveSettingsPath,
  resolveStopHookScriptDestination,
  SCRUBBER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  SCRUBBER_HOOK_MODULE_ID,
  hasHookEntry,
  addHookEntry,
  removeHookEntry,
};
