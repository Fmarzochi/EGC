'use strict';

// Manages EGC hook entries inside Claude Code settings.json.
// All merges are additive and idempotent: third-party hooks and unrelated
// settings keys are always preserved, and the EGC entry is identified by the
// installed hook script path so uninstall removes only what EGC added.
// Within the same event and matcher, an entry whose command runs a script
// with the same basename but a different path is treated as a stale copy of
// the EGC hook (left behind when the install location or invocation form
// changed) and is migrated in place instead of duplicated.

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
const ROUTER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/prompt-router.js';
const ROUTER_HOOK_MODULE_ID = 'claude-prompt-router-hook';
const GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/gateguard-fact-force.js';
const GATEGUARD_HOOK_MODULE_ID = 'claude-gateguard-fact-force-hook';

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
  return path.basename(scriptPaths[scriptPaths.length - 1]);
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

// gateguard-fact-force.js's only internal dependency (require('../lib/utils')
// resolved relative to itself), so any target that wires the gate outside the
// generic module-scaffold path needs both files copied together.
const GATEGUARD_LIB_SOURCE_RELATIVE_PATH = 'scripts/lib/utils.js';

/**
 * Builds copy operations that place gateguard-fact-force.js (and its one
 * dependency) under `<targetRoot>/scripts/hooks/` and `<targetRoot>/scripts/lib/`,
 * unconditionally (independent of module selection). Used by install targets
 * whose own root does not already receive the shared "hooks-runtime" module
 * scaffold (Codex, Windsurf) or that want the gate guaranteed regardless of
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
  ];
}

// Same merge operation shape as above, but for targets whose hooks.json
// location cannot be derived from resolveSettingsPath(targetRoot) the way
// Claude Code's can (e.g. Copilot's ~/.copilot/hooks/hooks.json, or
// Antigravity's project/global split): callers resolve destinationPath
// themselves and pass it in directly.
function createGateGuardHookMergeOperationForDestination(destinationPath, hookScriptPath, matcher) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: GATEGUARD_HOOK_MODULE_ID,
    sourceRelativePath: GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_TOOL_USE_EVENT,
    hookMatcher: matcher,
    hookScriptPath,
  };
}

module.exports = {
  BASH_DISPATCHER_HOOK_MODULE_ID,
  BASH_DISPATCHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  GATEGUARD_HOOK_MODULE_ID,
  GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  GATEGUARD_LIB_SOURCE_RELATIVE_PATH,
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
  addBashDispatcherHook,
  addGateGuardHook,
  addIntuitionHook,
  addRouterHook,
  addSessionStartHook,
  addStopHook,
  addWriteValidatorHook,
  applyBashDispatcherHookToFile,
  applyGateGuardHookToFile,
  applyHookEntryToFile,
  applyIntuitionHookToFile,
  applyRouterHookToFile,
  applySessionStartHookToFile,
  applyStopHookToFile,
  applyWriteValidatorHookToFile,
  buildSessionStartCommand,
  buildStopCommand,
  createGateGuardHookMergeOperationForDestination,
  createPreToolUseBashDispatcherHookMergeOperation,
  createGateGuardScriptCopyOperations,
  createPreToolUseGateGuardHookMergeOperation,
  createPreToolUseWriteValidatorHookMergeOperation,
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
  inspectHookEntryFile,
  inspectIntuitionHookFile,
  inspectRouterHookFile,
  inspectSessionStartHookFile,
  inspectStopHookFile,
  inspectWriteValidatorHookFile,
  readSettingsFile,
  removeBashDispatcherHook,
  removeBashDispatcherHookFromFile,
  removeGateGuardHook,
  removeGateGuardHookFromFile,
  removeHookEntryFromFile,
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
  resolveHookScriptDestination,
  resolveIntuitionHookScriptDestination,
  resolveRouterHookScriptDestination,
  resolveSettingsPath,
  resolveStopHookScriptDestination,
  resolveWriteValidatorHookScriptDestination,
};
