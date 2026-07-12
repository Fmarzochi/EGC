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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildHookCommand(scriptPath) {
  return `"${process.execPath}" "${scriptPath}"`; // NOSONAR jssecurity:S8705
}

function resolveAdapterScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'windsurf-gateguard-adapter.js');
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

function isStaleEgcEntry(entry, command) {
  if (!isPlainObject(entry) || typeof entry.command !== 'string' || entry.command === command) {
    return false;
  }
  return entry.command.includes(path.basename(ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH));
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

module.exports = {
  ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_RUN_COMMAND_EVENT,
  PRE_WRITE_CODE_EVENT,
  addWindsurfHookEntry,
  applyWindsurfGateGuardHookToFile,
  resolveAdapterScriptDestination,
  resolveHooksJsonPath,
};
