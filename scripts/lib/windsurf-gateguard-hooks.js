'use strict';

// Manages the GateGuard entry inside a Windsurf Cascade hooks.json file
// (.windsurf/hooks.json project-level, or ~/.codeium/windsurf/hooks.json
// user-level). Windsurf's hooks.json schema is a flat
// {hooks: {<event>: [{command, ...}]}} map - no matcher/group wrapper and no
// "type": "command" field like Claude Code's settings.json - so it shares
// flat-hooks-json-merge.js's merge logic (also used by Cursor's
// .cursor/hooks.json, the same non-Claude flat shape) instead of reusing
// claude-settings-hooks.js's addHookEntry(). Docs:
// https://docs.windsurf.com/windsurf/cascade/hooks (redirects to
// https://docs.devin.ai/desktop/cascade/hooks).

const path = require('node:path');
const {
  addFlatHookEntry,
  applyFlatHookToFile,
  buildHookCommand,
  inspectFlatHookFile,
  removeFlatHookEntry,
  removeFlatHookFromFile,
} = require('./flat-hooks-json-merge');

const HOST_LABEL = 'Windsurf';
const PRE_WRITE_CODE_EVENT = 'pre_write_code';
const PRE_RUN_COMMAND_EVENT = 'pre_run_command';
const ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/windsurf-gateguard-adapter.js';
const GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/windsurf-guardian-adapter.js';

// Only checking the GateGuard adapter's basename meant a relocated Guardian
// entry (e.g. after an install path change) was never recognized as stale
// here, so repair appended a duplicate pointing at the new path instead of
// migrating the old one in place, leaving both in hooks.json.
const EGC_ADAPTER_BASENAMES = [
  path.basename(ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH),
  path.basename(GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH),
];

function isOwnBasename(command) {
  return EGC_ADAPTER_BASENAMES.some(basename => command.includes(basename));
}

function resolveAdapterScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'windsurf-gateguard-adapter.js');
}

function resolveGuardianAdapterScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'windsurf-guardian-adapter.js');
}

function resolveHooksJsonPath(targetRoot) {
  return path.join(targetRoot, 'hooks.json');
}

function addWindsurfHookEntry(config, event, command) {
  return addFlatHookEntry(config, event, command, { isOwnBasename });
}

function applyWindsurfGateGuardHookToFile(hooksJsonPath, event, adapterScriptPath) {
  return applyFlatHookToFile(hooksJsonPath, HOST_LABEL, event, buildHookCommand(adapterScriptPath), { isOwnBasename });
}

function removeWindsurfHookEntry(config, event, command) {
  return removeFlatHookEntry(config, event, command);
}

// install-lifecycle.js's install-manifests.js-driven repair/inspect/
// uninstall previously had no notion of Windsurf's event-keyed hooks.json
// at all (only Claude's matcher/group settings.json schema), so a Windsurf
// GateGuard/Guardian entry: repair injected a bogus SessionStart group into
// the same file instead of touching pre_write_code/pre_run_command, doctor
// always reported drift (it checked for that same bogus SessionStart
// group, which never exists organically), and uninstall left the real
// entry behind pointing at a script the copy-file uninstall step had
// already deleted. These two functions give install-lifecycle.js the same
// remove/inspect primitives it already has for Claude's schema.
function removeWindsurfGateGuardHookFromFile(hooksJsonPath, event, adapterScriptPath) {
  return removeFlatHookFromFile(hooksJsonPath, HOST_LABEL, event, buildHookCommand(adapterScriptPath));
}

function inspectWindsurfGateGuardHookFile(hooksJsonPath, event, adapterScriptPath) {
  return inspectFlatHookFile(hooksJsonPath, HOST_LABEL, event, buildHookCommand(adapterScriptPath));
}

module.exports = {
  ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_RUN_COMMAND_EVENT,
  PRE_WRITE_CODE_EVENT,
  addWindsurfHookEntry,
  applyWindsurfGateGuardHookToFile,
  inspectWindsurfGateGuardHookFile,
  removeWindsurfGateGuardHookFromFile,
  removeWindsurfHookEntry,
  resolveAdapterScriptDestination,
  resolveGuardianAdapterScriptDestination,
  resolveHooksJsonPath,
};
