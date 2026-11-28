'use strict';

// Manages the Guardian entry inside the project's .openhands/hooks.json
// (OpenHands/docs' own hooks.mdx describes hooks as "configured
// per-repository"). OpenHands also reads a global ~/.openhands/hooks.json
// when the project has none; EGC does not write that one yet (see
// docs/spec/integration-tiers.md).
//
// OpenHands' hooks.json shape is genuinely different from every other host
// wired today: NO top-level "hooks" wrapper key -- event names
// (pre_tool_use, snake_case) sit directly at the document root, each value
// an array of {matcher, hooks: [{command, timeout}]} rule groups. That's
// why this reuses neither flat-hooks-json-merge.js (Kiro's flat
// {hooks: {event: [{matcher, command}]}} shape) nor
// claude-settings-hooks.js's destination-driven builders (Claude's
// {hooks: {event: [{matcher, hooks: [...]}]}} shape, which Goose matches
// but this does not, missing the wrapper).
//
// Blocks via exit code 2 (reason on stderr) or a
// {"decision":"deny","reason":"..."} JSON line on stdout -- this adapter
// always uses the exit-code form, same reasoning as every other host's
// adapter here. No rewrite capability is documented, so Token Crusher
// stays out of scope.

const fs = require('node:fs');
const path = require('node:path');

const HOST_LABEL = 'OpenHands';
const PRE_TOOL_USE_EVENT = 'pre_tool_use';
// The session events, in the same file and shape and with no matcher
// (OpenHands matches a session event to every group, with or without one):
// session_start restores the project memory, stop pushes the Team Brain.
const SESSION_START_EVENT = 'session_start';
const STOP_EVENT = 'stop';
const TERMINAL_MATCHER = 'terminal';
const GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/openhands-guardian-adapter.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildHookCommand(scriptPath) {
  return `"${process.execPath}" "${scriptPath}"`; // NOSONAR jssecurity:S8705
}

function readHooksFile(hooksJsonPath) {
  if (!fs.existsSync(hooksJsonPath)) {
    return {};
  }
  const raw = fs.readFileSync(hooksJsonPath, 'utf8');
  if (!raw.trim()) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${HOST_LABEL} hooks config at ${hooksJsonPath}: ${error.message}`, { cause: error });
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid ${HOST_LABEL} hooks config at ${hooksJsonPath}: expected a JSON object`);
  }
  return parsed;
}

function writeHooksFile(hooksJsonPath, config) {
  fs.mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
  fs.writeFileSync(hooksJsonPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function isMatcherGroup(group, matcher) {
  return isPlainObject(group) && group.matcher === matcher;
}

function isEgcHookCommandEntry(entry, command) {
  return isPlainObject(entry) && entry.command === command;
}

// Mirrors claude-settings-hooks.js's mergeMatcherGroups/buildNewGroup
// shape, adapted for OpenHands' matcher-group array (no isOwnBasename
// migration here -- OpenHands is a brand-new integration with no prior
// install path to migrate away from). The command goes into the first
// group of the event with that matcher, and into a new group when there is
// none: OpenHands runs every group a call matches, so a command in two
// groups would run twice. Nothing changes when a group already has it.
function addOpenHandsHookEntry(config, event, matcher, command) {
  const base = isPlainObject(config) ? config : {};
  if (hasOpenHandsHookEntry(base, event, matcher, command)) {
    return { config: base, changed: false };
  }
  const existingGroups = Array.isArray(base[event]) ? base[event] : [];
  const entry = { type: 'command', command };
  const first = existingGroups.findIndex(group => isMatcherGroup(group, matcher));
  const groups = first === -1
    ? [...existingGroups, matcher === undefined ? { hooks: [entry] } : { matcher, hooks: [entry] }]
    : existingGroups.map((group, index) => (index === first
      ? { ...group, hooks: [...(Array.isArray(group.hooks) ? group.hooks : []), entry] }
      : group));
  return { config: { ...base, [event]: groups }, changed: true };
}

function removeOpenHandsHookEntry(config, event, matcher, command) {
  const base = isPlainObject(config) ? config : {};
  const existingGroups = Array.isArray(base[event]) ? base[event] : [];
  let changed = false;

  const groups = existingGroups
    .map(group => {
      if (!isMatcherGroup(group, matcher)) {
        return group;
      }
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      const nextHooks = hooks.filter(entry => !isEgcHookCommandEntry(entry, command));
      if (nextHooks.length !== hooks.length) {
        changed = true;
      }
      return { ...group, hooks: nextHooks };
    })
    .filter(group => !isMatcherGroup(group, matcher) || group.hooks.length > 0);

  if (!changed) {
    return { config: base, changed: false };
  }

  const next = { ...base, [event]: groups };
  if (groups.length === 0) {
    delete next[event];
  }
  return { config: next, changed: true };
}

function hasOpenHandsHookEntry(config, event, matcher, command) {
  const base = isPlainObject(config) ? config : {};
  const existingGroups = Array.isArray(base[event]) ? base[event] : [];
  return existingGroups.some(group => (
    isMatcherGroup(group, matcher)
    && Array.isArray(group.hooks)
    && group.hooks.some(entry => isEgcHookCommandEntry(entry, command))
  ));
}

function resolveGuardianAdapterScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'openhands-guardian-adapter.js');
}

function resolveHooksJsonPath(projectRoot) {
  return path.join(projectRoot, '.openhands', 'hooks.json');
}

// One EGC script under one event of the file, with a matcher for a tool
// event and none for a session event.
function applyOpenHandsHookToFile(hooksJsonPath, scriptPath, event, matcher) {
  const command = buildHookCommand(scriptPath);
  const current = readHooksFile(hooksJsonPath);
  const { config, changed } = addOpenHandsHookEntry(current, event, matcher, command);
  if (changed) {
    writeHooksFile(hooksJsonPath, config);
  }
  return { changed };
}

function removeOpenHandsHookFromFile(hooksJsonPath, scriptPath, event, matcher) {
  if (!fs.existsSync(hooksJsonPath)) {
    return { changed: false };
  }
  const command = buildHookCommand(scriptPath);
  const current = readHooksFile(hooksJsonPath);
  const { config, changed } = removeOpenHandsHookEntry(current, event, matcher, command);
  if (changed) {
    writeHooksFile(hooksJsonPath, config);
  }
  return { changed };
}

function inspectOpenHandsHookFile(hooksJsonPath, scriptPath, event, matcher) {
  try {
    const command = buildHookCommand(scriptPath);
    const current = readHooksFile(hooksJsonPath);
    return hasOpenHandsHookEntry(current, event, matcher, command) ? 'ok' : 'drifted';
  } catch {
    return 'drifted';
  }
}

function applyOpenHandsGuardianHookToFile(hooksJsonPath, adapterScriptPath) {
  return applyOpenHandsHookToFile(hooksJsonPath, adapterScriptPath, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER);
}

function removeOpenHandsGuardianHookFromFile(hooksJsonPath, adapterScriptPath) {
  return removeOpenHandsHookFromFile(hooksJsonPath, adapterScriptPath, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER);
}

function inspectOpenHandsGuardianHookFile(hooksJsonPath, adapterScriptPath) {
  return inspectOpenHandsHookFile(hooksJsonPath, adapterScriptPath, PRE_TOOL_USE_EVENT, TERMINAL_MATCHER);
}

module.exports = {
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_TOOL_USE_EVENT,
  SESSION_START_EVENT,
  STOP_EVENT,
  TERMINAL_MATCHER,
  addOpenHandsHookEntry,
  applyOpenHandsGuardianHookToFile,
  applyOpenHandsHookToFile,
  buildHookCommand,
  inspectOpenHandsGuardianHookFile,
  inspectOpenHandsHookFile,
  removeOpenHandsGuardianHookFromFile,
  removeOpenHandsHookEntry,
  removeOpenHandsHookFromFile,
  resolveGuardianAdapterScriptDestination,
  resolveHooksJsonPath,
};
