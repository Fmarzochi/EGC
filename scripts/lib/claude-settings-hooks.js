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
const {
  PRE_RUN_COMMAND_EVENT: WINDSURF_PRE_RUN_COMMAND_EVENT,
  PRE_WRITE_CODE_EVENT: WINDSURF_PRE_WRITE_CODE_EVENT,
  applyWindsurfGateGuardHookToFile,
  inspectWindsurfGateGuardHookFile,
  removeWindsurfGateGuardHookFromFile,
} = require('./windsurf-gateguard-hooks');
const {
  BEFORE_SHELL_EXECUTION_EVENT: CURSOR_BEFORE_SHELL_EXECUTION_EVENT,
  applyCursorGuardianHookToFile,
  inspectCursorGuardianHookFile,
  removeCursorGuardianHookFromFile,
} = require('./cursor-guardian-hooks');
const {
  CRUSHER_HOOK_DISPATCH_EVENT: CURSOR_CRUSHER_HOOK_DISPATCH_EVENT,
  applyCursorCrusherHookToFile,
  inspectCursorCrusherHookFile,
  removeCursorCrusherHookFromFile,
} = require('./cursor-crusher-hooks');
const {
  PRE_TOOL_USE_EVENT: KIRO_PRE_TOOL_USE_EVENT,
  applyKiroGuardianHookToFile,
  inspectKiroGuardianHookFile,
  removeKiroGuardianHookFromFile,
} = require('./kiro-guardian-hooks');
const {
  OPERATION_DISPATCH_TAG: AMAZONQ_OPERATION_DISPATCH_TAG,
  applyAmazonQGuardianHookToFile,
  inspectAmazonQGuardianHookFile,
  removeAmazonQGuardianHookFromFile,
} = require('./amazonq-guardian-hooks');
const {
  PRE_TOOL_USE_EVENT: OPENHANDS_PRE_TOOL_USE_EVENT,
  applyOpenHandsGuardianHookToFile,
  inspectOpenHandsGuardianHookFile,
  removeOpenHandsGuardianHookFromFile,
} = require('./openhands-guardian-hooks');
const {
  ROOCODE_DENYLIST_TAG,
  applyRoocodeDenylistToFile,
  inspectRoocodeDenylistFile,
  removeRoocodeDenylistFromFile,
} = require('./roocode-guardian-denylist');

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
const BASH_GUARDIAN_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/pre-bash-guardian-validate.js';
const BASH_GUARDIAN_HOOK_MODULE_ID = 'egc-bash-guardian-hook';
const CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/crusher-hook.js';
const CRUSHER_HOOK_MODULE_ID = 'egc-crusher-hook';
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

// Token Crusher hook (crusher-hook.js): standalone PreToolUse rewrite for hosts
// other than Claude Code that read hooks.json with the same schema (Codex,
// CodeBuddy). Its dependency tree is crusher-hook.js -> pre-bash-crusher-rewrite
// -> lib/crusher/engine, plus the shared pretooluse-output envelope. All are
// scaffolded together, preserving their relative paths so the requires resolve.
const CRUSHER_HOOK_LIB_SOURCES = [
  'scripts/hooks/pre-bash-crusher-rewrite.js',
  'scripts/hooks/pretooluse-output.js',
  'scripts/lib/crusher/engine.js',
];

function resolveCrusherHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'crusher-hook.js');
}

function createPreToolUseCrusherHookMergeOperation(targetRoot, matcher) {
  const hookScriptPath = resolveCrusherHookScriptDestination(targetRoot);
  return buildPreToolUseMergeOperation(
    targetRoot,
    CRUSHER_HOOK_MODULE_ID,
    CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    hookScriptPath,
    matcher
  );
}

function createCrusherScriptCopyOperations(createRemappedOperation, targetRoot) {
  return [
    createRemappedOperation(
      CRUSHER_HOOK_MODULE_ID,
      CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveCrusherHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    ...CRUSHER_HOOK_LIB_SOURCES.map(src => createRemappedOperation(
      CRUSHER_HOOK_MODULE_ID,
      src,
      path.join(targetRoot, ...src.split('/')),
      { strategy: 'preserve-relative-path' }
    )),
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

// Crusher variant of the destination-driven merge op, for hosts whose
// hooks.json path is not derivable from targetRoot (Copilot ~/.copilot/hooks,
// Antigravity's project/global split). Same Claude hooks.json schema.
function createCrusherHookMergeOperationForDestination(destinationPath, hookScriptPath, matcher) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: CRUSHER_HOOK_MODULE_ID,
    sourceRelativePath: CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_TOOL_USE_EVENT,
    hookMatcher: matcher,
    hookScriptPath,
  };
}

// EGC Guardian command validator (pre-bash-guardian-validate.js): standalone
// PreToolUse hook, same shape as the Crusher hook above, for hosts other than
// Claude Code that read hooks.json with the same schema. 2026-07-27 audit
// (EGC-460..464) found this was the one piece consistently missing from every
// non-Claude target that already had GateGuard + Crusher wired: those two
// give investigation-gating and output-compression, but neither one
// validates a command against the Guardian's actual allowlist/denylist —
// only pre-bash-guardian-validate.js does, and it was never registered
// anywhere except Claude Code's own bash-hook-dispatcher.js chain.
const BASH_GUARDIAN_HOOK_LIB_SOURCES = [
  'scripts/lib/guardian-bin.js',
  'scripts/lib/shell-split.js',
];

function resolveBashGuardianHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'pre-bash-guardian-validate.js');
}

function createPreToolUseBashGuardianHookMergeOperation(targetRoot, matcher) {
  const hookScriptPath = resolveBashGuardianHookScriptDestination(targetRoot);
  return buildPreToolUseMergeOperation(
    targetRoot,
    BASH_GUARDIAN_HOOK_MODULE_ID,
    BASH_GUARDIAN_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    hookScriptPath,
    matcher
  );
}

// Destination-driven variant, for hosts whose hooks.json path is not
// derivable from targetRoot (Copilot ~/.copilot/hooks, Antigravity's
// project/global split). Same Claude hooks.json schema.
function createBashGuardianHookMergeOperationForDestination(destinationPath, hookScriptPath, matcher) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: BASH_GUARDIAN_HOOK_MODULE_ID,
    sourceRelativePath: BASH_GUARDIAN_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_TOOL_USE_EVENT,
    hookMatcher: matcher,
    hookScriptPath,
  };
}

function createBashGuardianScriptCopyOperations(createRemappedOperation, targetRoot) {
  return [
    createRemappedOperation(
      BASH_GUARDIAN_HOOK_MODULE_ID,
      BASH_GUARDIAN_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveBashGuardianHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    ...BASH_GUARDIAN_HOOK_LIB_SOURCES.map(src => createRemappedOperation(
      BASH_GUARDIAN_HOOK_MODULE_ID,
      src,
      path.join(targetRoot, ...src.split('/')),
      { strategy: 'preserve-relative-path' }
    )),
  ];
}

// Windsurf's, Cursor's, and Kiro's translation adapters
// (windsurf-guardian-adapter.js, cursor-guardian-adapter.js,
// kiro-guardian-adapter.js) all require ../lib/adapter-stdin-json.js for
// their truncation-aware stdin reader -- unlike pre-bash-guardian-
// validate.js itself, which every other target (Claude Code, Codex,
// Copilot, CodeBuddy, Antigravity) calls directly with no translation
// layer and so never needs this file. Kept separate from
// createBashGuardianScriptCopyOperations (shared by every target,
// including ones with no adapter) instead of folding it into
// BASH_GUARDIAN_HOOK_LIB_SOURCES, so targets without an adapter don't get
// a copy of a file they never require(). Confirmed missing on the real
// machine for all three hosts after merge (2026-07-29): the adapter
// crashed with MODULE_NOT_FOUND on every invocation because this file was
// never part of any target's copy operations.
const ADAPTER_STDIN_JSON_SOURCE_RELATIVE_PATH = 'scripts/lib/adapter-stdin-json.js';

function createAdapterStdinJsonCopyOperation(createRemappedOperation, targetRoot) {
  return createRemappedOperation(
    BASH_GUARDIAN_HOOK_MODULE_ID,
    ADAPTER_STDIN_JSON_SOURCE_RELATIVE_PATH,
    path.join(targetRoot, ...ADAPTER_STDIN_JSON_SOURCE_RELATIVE_PATH.split('/')),
    { strategy: 'preserve-relative-path' }
  );
}

// Roo Code has no external hook API to shell out to (see
// roocode-guardian-denylist.js's own header for the confirmed evidence), so
// unlike every other host's merge operation this has no script to copy: it
// only ever merges roo-cline.deniedCommands into the workspace's own
// .vscode/settings.json. sourceRelativePath points at the module driving
// this merge (not a file that gets copied anywhere) purely so install-state
// tracking has a stable, real identifier for this operation, consistent
// with every other managed operation in this system.
const ROOCODE_DENYLIST_MODULE_ID = 'egc-roocode-guardian-denylist';
const ROOCODE_DENYLIST_SOURCE_RELATIVE_PATH = 'scripts/lib/roocode-guardian-denylist.js';

function createRoocodeDenylistMergeOperation(settingsPath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: ROOCODE_DENYLIST_MODULE_ID,
    sourceRelativePath: ROOCODE_DENYLIST_SOURCE_RELATIVE_PATH,
    destinationPath: settingsPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: ROOCODE_DENYLIST_TAG,
  };
}

// PreCompact -> egc-memory-save hook: closes EGC-495 (no mechanism re-injected
// state after a context compaction). egc-memory-save.js writes a guaranteed
// on-disk snapshot (writeSnapshotToDisk, no AI cooperation required) and
// echoes a promptForAssistant asking the model to call update_state with the
// session's decisions/preferences/next-steps -- this stdout is what a
// PreCompact hook contributes to the surviving post-compaction context
// (confirmed empirically: PreCompact hook stdout is not swept away by
// summarization the way regular turn history is). Its dependency chain is
// egc-memory-save.js -> lib/state-snapshot.js -> lib/branch-state.js.
const EGC_MEMORY_SAVE_HOOK_LIB_SOURCES = [
  'scripts/lib/state-snapshot.js',
  'scripts/lib/branch-state.js',
];

function resolveEgcMemorySaveHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'egc-memory-save.js');
}

function hasPreCompactHook(settings, hookScriptPath) {
  return hasHookEntry(settings, PRE_COMPACT_EVENT, hookScriptPath);
}

function addPreCompactHook(settings, hookScriptPath) {
  return addHookEntry(settings, PRE_COMPACT_EVENT, hookScriptPath);
}

function removePreCompactHook(settings, hookScriptPath) {
  return removeHookEntry(settings, PRE_COMPACT_EVENT, hookScriptPath);
}

function applyPreCompactHookToFile(settingsPath, hookScriptPath) {
  return applyHookEntryToFile(settingsPath, PRE_COMPACT_EVENT, hookScriptPath);
}

function removePreCompactHookFromFile(settingsPath, hookScriptPath) {
  return removeHookEntryFromFile(settingsPath, PRE_COMPACT_EVENT, hookScriptPath);
}

function inspectPreCompactHookFile(settingsPath, hookScriptPath) {
  return inspectHookEntryFile(settingsPath, PRE_COMPACT_EVENT, hookScriptPath);
}

function createPreCompactHookMergeOperation(targetRoot) {
  const hookScriptPath = resolveEgcMemorySaveHookScriptDestination(targetRoot);
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: EGC_MEMORY_SAVE_HOOK_MODULE_ID,
    sourceRelativePath: EGC_MEMORY_SAVE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: resolveSettingsPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_COMPACT_EVENT,
    hookScriptPath,
    hookCommand: buildHookCommand(hookScriptPath),
  };
}

// Destination-driven variant, for hosts whose hooks.json path is not
// derivable from targetRoot (Copilot ~/.copilot/hooks, Antigravity's
// project/global split). Same Claude hooks.json schema. Only wire this for a
// host confirmed to actually fire PreCompact -- unlike PreToolUse, this event
// is not documented publicly for every host, so callers must verify first
// (see EGC-497) rather than wiring it blindly the way Crusher's Fase B did.
function createPreCompactHookMergeOperationForDestination(destinationPath, hookScriptPath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: EGC_MEMORY_SAVE_HOOK_MODULE_ID,
    sourceRelativePath: EGC_MEMORY_SAVE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_COMPACT_EVENT,
    hookScriptPath,
    hookCommand: buildHookCommand(hookScriptPath),
  };
}

function createEgcMemorySaveScriptCopyOperations(createRemappedOperation, targetRoot) {
  return [
    createRemappedOperation(
      EGC_MEMORY_SAVE_HOOK_MODULE_ID,
      EGC_MEMORY_SAVE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveEgcMemorySaveHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    ...EGC_MEMORY_SAVE_HOOK_LIB_SOURCES.map(src => createRemappedOperation(
      EGC_MEMORY_SAVE_HOOK_MODULE_ID,
      src,
      path.join(targetRoot, ...src.split('/')),
      { strategy: 'preserve-relative-path' }
    )),
  ];
}

// PostCompact -> reuses claude-session-start.js (already scaffolded for
// SessionStart, no extra copy operation needed). readStdinJson() there
// already falls back to {} on missing/invalid stdin and resolveProjectPath()
// falls back to CLAUDE_PROJECT_DIR/PWD/cwd() when input.cwd is absent, so the
// exact same tested, proven state-load-and-print logic that opens every
// session also re-injects state right after a compaction finishes -- closes
// EGC-495 without inventing new untested logic. Confirmed real by the
// Multica squad (EGC-497) via Claude Code binary inspection: PostCompact is
// an actual hook event (executePostCompactHooks, markPostCompaction).
function createPostCompactHookMergeOperation(targetRoot) {
  const hookScriptPath = resolveHookScriptDestination(targetRoot);
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: HOOK_MODULE_ID,
    sourceRelativePath: HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: resolveSettingsPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: POST_COMPACT_EVENT,
    hookScriptPath,
    hookCommand: buildHookCommand(hookScriptPath),
  };
}

// Windsurf's two managed events (pre_write_code, pre_run_command) both go
// through the same flat-hooks.json helpers, just forwarding whichever of the
// two the operation actually carries -- one handler trio, two table keys,
// equivalent to the old `MANAGED_WINDSURF_HOOK_EVENTS.has(...)` Set check.
const WINDSURF_HOOK_OPERATION_HANDLERS = {
  apply: operation => applyWindsurfGateGuardHookToFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
  remove: operation => removeWindsurfGateGuardHookFromFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
  inspect: operation => inspectWindsurfGateGuardHookFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
};

// Single source of truth for "given this operation's hookEvent, which
// apply/remove/inspect functions handle it". Shared by applyManagedHookOperation
// below, and by install-lifecycle.js's uninstallManagedHookOperation and
// inspectManagedOperation (via resolveHookOperationHandlers) -- previously
// each of those three call sites re-enumerated this same ~11-event chain
// independently, so adding a new host meant remembering to update 2-3 places
// by hand (EGC-539 audit finding). SessionStart is deliberately absent: it is
// the fallback for any hookEvent not listed here, matching every original
// chain's trailing `else` branch (see resolveHookOperationHandlers).
const HOOK_EVENT_OPERATION_HANDLERS = {
  [STOP_EVENT]: {
    apply: operation => applyStopHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeStopHookFromFile(operation.destinationPath, operation.hookScriptPath),
    inspect: operation => inspectStopHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [USER_PROMPT_SUBMIT_EVENT]: {
    apply: operation => applyIntuitionHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeIntuitionHookFromFile(operation.destinationPath, operation.hookScriptPath),
    inspect: operation => inspectIntuitionHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [PRE_TOOL_USE_EVENT]: {
    // Apply/inspect scope to the operation's matcher, since several distinct
    // PreToolUse hooks (Bash dispatcher, write validator, GateGuard, Crusher)
    // share this event under different matchers. Remove does not: a given
    // EGC hook script path is only ever registered once per event regardless
    // of matcher, and removeHookEntry() already strips it from every group.
    apply: operation => applyHookEntryToFile(operation.destinationPath, PRE_TOOL_USE_EVENT, operation.hookScriptPath, { matcher: operation.hookMatcher }),
    remove: operation => removeHookEntryFromFile(operation.destinationPath, PRE_TOOL_USE_EVENT, operation.hookScriptPath),
    inspect: operation => inspectHookEntryFile(operation.destinationPath, PRE_TOOL_USE_EVENT, operation.hookScriptPath, operation.hookMatcher),
  },
  [PRE_COMPACT_EVENT]: {
    apply: operation => applyPreCompactHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removePreCompactHookFromFile(operation.destinationPath, operation.hookScriptPath),
    inspect: operation => inspectPreCompactHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [POST_COMPACT_EVENT]: {
    // PostCompact reuses claude-session-start.js (see
    // createPostCompactHookMergeOperation above) but is still merged/removed/
    // inspected under its own event key via the generic entry helpers, not
    // the SessionStart-specific ones.
    apply: operation => applyHookEntryToFile(operation.destinationPath, POST_COMPACT_EVENT, operation.hookScriptPath),
    remove: operation => removeHookEntryFromFile(operation.destinationPath, POST_COMPACT_EVENT, operation.hookScriptPath),
    inspect: operation => inspectHookEntryFile(operation.destinationPath, POST_COMPACT_EVENT, operation.hookScriptPath),
  },
  [WINDSURF_PRE_WRITE_CODE_EVENT]: WINDSURF_HOOK_OPERATION_HANDLERS,
  [WINDSURF_PRE_RUN_COMMAND_EVENT]: WINDSURF_HOOK_OPERATION_HANDLERS,
  [CURSOR_BEFORE_SHELL_EXECUTION_EVENT]: {
    // Only apply threads seedPath through: it seeds a freshly scaffolded
    // hooks.json on first install and has no meaning for remove/inspect,
    // which only ever read or strip an already-existing entry.
    apply: operation => applyCursorGuardianHookToFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath, { seedPath: operation.seedPath }),
    remove: operation => removeCursorGuardianHookFromFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
    inspect: operation => inspectCursorGuardianHookFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
  },
  [CURSOR_CRUSHER_HOOK_DISPATCH_EVENT]: {
    apply: operation => applyCursorCrusherHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeCursorCrusherHookFromFile(operation.destinationPath, operation.hookScriptPath),
    inspect: operation => inspectCursorCrusherHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [KIRO_PRE_TOOL_USE_EVENT]: {
    apply: operation => applyKiroGuardianHookToFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
    remove: operation => removeKiroGuardianHookFromFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
    inspect: operation => inspectKiroGuardianHookFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
  },
  [AMAZONQ_OPERATION_DISPATCH_TAG]: {
    apply: operation => applyAmazonQGuardianHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeAmazonQGuardianHookFromFile(operation.destinationPath, operation.hookScriptPath),
    inspect: operation => inspectAmazonQGuardianHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [OPENHANDS_PRE_TOOL_USE_EVENT]: {
    apply: operation => applyOpenHandsGuardianHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeOpenHandsGuardianHookFromFile(operation.destinationPath, operation.hookScriptPath),
    inspect: operation => inspectOpenHandsGuardianHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [ROOCODE_DENYLIST_TAG]: {
    apply: operation => applyRoocodeDenylistToFile(operation.destinationPath),
    remove: operation => removeRoocodeDenylistFromFile(operation.destinationPath),
    inspect: operation => inspectRoocodeDenylistFile(operation.destinationPath),
  },
};

const SESSION_START_HOOK_OPERATION_HANDLERS = {
  apply: operation => applySessionStartHookToFile(operation.destinationPath, operation.hookScriptPath),
  remove: operation => removeSessionStartHookFromFile(operation.destinationPath, operation.hookScriptPath),
  inspect: operation => inspectSessionStartHookFile(operation.destinationPath, operation.hookScriptPath),
};

// Any hookEvent not present in HOOK_EVENT_OPERATION_HANDLERS (currently just
// SessionStart itself) falls back to the SessionStart handler trio -- this is
// the trailing `else` branch every original dispatch chain ended with.
function resolveHookOperationHandlers(hookEvent) {
  return HOOK_EVENT_OPERATION_HANDLERS[hookEvent] || SESSION_START_HOOK_OPERATION_HANDLERS;
}

// Shared by install/apply.js and install-lifecycle.js's repair path: both
// need the exact same HOOK_OPERATION_KIND dispatch (SessionStart is the
// fallback for any event not explicitly handled above it), so it lives here
// once instead of being duplicated per caller.
function applyManagedHookOperation(operation) {
  resolveHookOperationHandlers(operation.hookEvent).apply(operation);
}

module.exports = {
  BASH_DISPATCHER_HOOK_MODULE_ID,
  BASH_DISPATCHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  BASH_GUARDIAN_HOOK_MODULE_ID,
  createRoocodeDenylistMergeOperation,
  BASH_GUARDIAN_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  GATEGUARD_HOOK_MODULE_ID,
  GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  GATEGUARD_LIB_SOURCE_RELATIVE_PATH,
  CRUSHER_HOOK_LIB_SOURCES,
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
  addBashDispatcherHook,
  addGateGuardHook,
  addIntuitionHook,
  addPreCompactHook,
  addRouterHook,
  addSessionStartHook,
  addStopHook,
  addWriteValidatorHook,
  applyBashDispatcherHookToFile,
  applyGateGuardHookToFile,
  applyHookEntryToFile,
  applyIntuitionHookToFile,
  applyManagedHookOperation,
  applyPreCompactHookToFile,
  applyRouterHookToFile,
  applySessionStartHookToFile,
  applyStopHookToFile,
  applyWriteValidatorHookToFile,
  buildHookCommand,
  buildSessionStartCommand,
  buildStopCommand,
  createGateGuardHookMergeOperationForDestination,
  createPreToolUseBashDispatcherHookMergeOperation,
  createGateGuardScriptCopyOperations,
  createPreToolUseGateGuardHookMergeOperation,
  createCrusherScriptCopyOperations,
  createPreToolUseCrusherHookMergeOperation,
  createCrusherHookMergeOperationForDestination,
  resolveCrusherHookScriptDestination,
  createBashGuardianScriptCopyOperations,
  createPreToolUseBashGuardianHookMergeOperation,
  createBashGuardianHookMergeOperationForDestination,
  resolveBashGuardianHookScriptDestination,
  ADAPTER_STDIN_JSON_SOURCE_RELATIVE_PATH,
  createAdapterStdinJsonCopyOperation,
  createPreToolUseWriteValidatorHookMergeOperation,
  createSessionStartHookMergeOperation,
  createStopHookMergeOperation,
  createUserPromptSubmitHookMergeOperation,
  createUserPromptSubmitRouterHookMergeOperation,
  createEgcMemorySaveScriptCopyOperations,
  createPreCompactHookMergeOperation,
  createPreCompactHookMergeOperationForDestination,
  createPostCompactHookMergeOperation,
  resolveEgcMemorySaveHookScriptDestination,
  hasBashDispatcherHook,
  hasGateGuardHook,
  hasIntuitionHook,
  hasPreCompactHook,
  hasRouterHook,
  hasSessionStartHook,
  hasStopHook,
  hasWriteValidatorHook,
  inspectBashDispatcherHookFile,
  inspectGateGuardHookFile,
  inspectHookEntryFile,
  inspectIntuitionHookFile,
  inspectPreCompactHookFile,
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
  removePreCompactHook,
  removePreCompactHookFromFile,
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
  resolveHookOperationHandlers,
  resolveHookScriptDestination,
  resolveIntuitionHookScriptDestination,
  resolveRouterHookScriptDestination,
  resolveSettingsPath,
  resolveStopHookScriptDestination,
  resolveWriteValidatorHookScriptDestination,
};
