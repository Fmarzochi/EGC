'use strict';

// Manages the GateGuard entry inside a Windsurf Cascade hooks.json file
// (.windsurf/hooks.json project-level, or ~/.codeium/windsurf/hooks.json
// user-level). Windsurf's hooks.json schema is a flat
// {hooks: {<event>: [{command, ...}]}} map - no matcher/group wrapper and no
// "type": "command" field like Claude Code's settings.json - so it needs its
// own merge logic instead of reusing claude-settings-hooks.js's
// addHookEntry(). Docs: https://docs.windsurf.com/windsurf/cascade/hooks
// (redirects to https://docs.devin.ai/desktop/cascade/hooks).

const fs = require('node:fs');
const path = require('node:path');

const PRE_WRITE_CODE_EVENT = 'pre_write_code';
const PRE_RUN_COMMAND_EVENT = 'pre_run_command';
const ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/windsurf-gateguard-adapter.js';
const GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/windsurf-guardian-adapter.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildHookCommand(scriptPath) {
  return `"${process.execPath}" "${scriptPath}"`; // NOSONAR jssecurity:S8705
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
    throw new Error(`Failed to parse Windsurf hooks config at ${hooksJsonPath}: ${error.message}`, { cause: error });
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid Windsurf hooks config at ${hooksJsonPath}: expected a JSON object`);
  }
  return parsed;
}

function writeHooksFile(hooksJsonPath, config) {
  fs.mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
  fs.writeFileSync(hooksJsonPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function isEgcEntry(entry, command) {
  return isPlainObject(entry) && entry.command === command;
}

const EGC_ADAPTER_BASENAMES = [
  path.basename(ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH),
  path.basename(GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH),
];

function isStaleEgcEntry(entry, command) {
  if (!isPlainObject(entry) || typeof entry.command !== 'string' || entry.command === command) {
    return false;
  }
  // Only checking the GateGuard adapter's basename meant a relocated
  // Guardian entry (e.g. after an install path change) was never
  // recognized as stale here, so repair appended a duplicate pointing at
  // the new path instead of migrating the old one in place, leaving both
  // in hooks.json.
  return EGC_ADAPTER_BASENAMES.some(basename => entry.command.includes(basename));
}

function addWindsurfHookEntry(config, event, command) {
  const base = isPlainObject(config) ? config : {};
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};
  const existing = Array.isArray(hooks[event]) ? hooks[event] : [];

  if (existing.some(entry => isEgcEntry(entry, command))) {
    return { config: base, changed: false };
  }

  // Migrate a stale entry in place (same adapter script, different install
  // path) instead of appending a duplicate.
  let migrated = false;
  const nextEntries = existing.map(entry => {
    if (!migrated && isStaleEgcEntry(entry, command)) {
      migrated = true;
      return { ...entry, command };
    }
    return entry;
  });

  if (!migrated) {
    nextEntries.push({ command });
  }

  hooks[event] = nextEntries;
  return { config: { ...base, hooks }, changed: true };
}

function applyWindsurfGateGuardHookToFile(hooksJsonPath, event, adapterScriptPath) {
  const command = buildHookCommand(adapterScriptPath);
  const current = readHooksFile(hooksJsonPath);
  const { config, changed } = addWindsurfHookEntry(current, event, command);
  if (changed) {
    writeHooksFile(hooksJsonPath, config);
  }
  return { changed };
}

// Pure counterpart to addWindsurfHookEntry: drops only the EGC-managed
// entry (matched by exact command) from hooks[event], leaving every other
// entry (third-party hooks, other events) untouched. Deletes the event key
// entirely once it is empty, rather than leaving a dangling `[]` in the
// user's hooks.json.
function removeWindsurfHookEntry(config, event, command) {
  const base = isPlainObject(config) ? config : {};
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};
  const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
  const nextEntries = existing.filter(entry => !isEgcEntry(entry, command));

  if (nextEntries.length === existing.length) {
    return { config: base, changed: false };
  }

  if (nextEntries.length > 0) {
    hooks[event] = nextEntries;
  } else {
    delete hooks[event];
  }
  return { config: { ...base, hooks }, changed: true };
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
  if (!fs.existsSync(hooksJsonPath)) {
    return { changed: false };
  }
  const command = buildHookCommand(adapterScriptPath);
  const current = readHooksFile(hooksJsonPath);
  const { config, changed } = removeWindsurfHookEntry(current, event, command);
  if (changed) {
    writeHooksFile(hooksJsonPath, config);
  }
  return { changed };
}

function inspectWindsurfGateGuardHookFile(hooksJsonPath, event, adapterScriptPath) {
  try {
    const command = buildHookCommand(adapterScriptPath);
    const current = readHooksFile(hooksJsonPath);
    const hooks = isPlainObject(current.hooks) ? current.hooks : {};
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    return existing.some(entry => isEgcEntry(entry, command)) ? 'ok' : 'drifted';
  } catch {
    return 'drifted';
  }
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
