'use strict';

// Manages the Guardian entry inside a Cursor Agent Hooks project-level
// .cursor/hooks.json file. Cursor's schema is a flat
// {version, hooks: {<event>: [{command, timeout?, matcher?}]}} map -- no
// matcher/group wrapper and no "type": "command" field like Claude Code's
// settings.json -- so it needs its own merge logic instead of reusing
// claude-settings-hooks.js's addHookEntry(). Mirrors
// windsurf-gateguard-hooks.js's approach for the same reason (a different
// non-Claude hooks.json shape). Docs: https://cursor.com/docs/agent/hooks

const fs = require('node:fs');
const path = require('node:path');

const BEFORE_SHELL_EXECUTION_EVENT = 'beforeShellExecution';
const GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/cursor-guardian-adapter.js';
const HOOKS_CONFIG_VERSION = 1;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildHookCommand(scriptPath) {
  return `"${process.execPath}" "${scriptPath}"`; // NOSONAR jssecurity:S8705
}

function resolveGuardianAdapterScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'cursor-guardian-adapter.js');
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
    throw new Error(`Failed to parse Cursor hooks config at ${hooksJsonPath}: ${error.message}`, { cause: error });
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid Cursor hooks config at ${hooksJsonPath}: expected a JSON object`);
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

const EGC_ADAPTER_BASENAME = path.basename(GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);

function isStaleEgcEntry(entry, command) {
  if (!isPlainObject(entry) || typeof entry.command !== 'string' || entry.command === command) {
    return false;
  }
  return entry.command.includes(EGC_ADAPTER_BASENAME);
}

function addCursorHookEntry(config, event, command) {
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
  return {
    config: { version: base.version || HOOKS_CONFIG_VERSION, ...base, hooks },
    changed: true,
  };
}

function applyCursorGuardianHookToFile(hooksJsonPath, event, adapterScriptPath) {
  const command = buildHookCommand(adapterScriptPath);
  const current = readHooksFile(hooksJsonPath);
  const { config, changed } = addCursorHookEntry(current, event, command);
  if (changed) {
    writeHooksFile(hooksJsonPath, config);
  }
  return { changed };
}

// Pure counterpart to addCursorHookEntry: drops only the EGC-managed entry
// (matched by exact command) from hooks[event], leaving every other entry
// (third-party hooks, other events) untouched. Deletes the event key
// entirely once it is empty, rather than leaving a dangling `[]` in the
// user's hooks.json.
function removeCursorHookEntry(config, event, command) {
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

function removeCursorGuardianHookFromFile(hooksJsonPath, event, adapterScriptPath) {
  if (!fs.existsSync(hooksJsonPath)) {
    return { changed: false };
  }
  const command = buildHookCommand(adapterScriptPath);
  const current = readHooksFile(hooksJsonPath);
  const { config, changed } = removeCursorHookEntry(current, event, command);
  if (changed) {
    writeHooksFile(hooksJsonPath, config);
  }
  return { changed };
}

function inspectCursorGuardianHookFile(hooksJsonPath, event, adapterScriptPath) {
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
  BEFORE_SHELL_EXECUTION_EVENT,
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  addCursorHookEntry,
  applyCursorGuardianHookToFile,
  inspectCursorGuardianHookFile,
  removeCursorGuardianHookFromFile,
  removeCursorHookEntry,
  resolveGuardianAdapterScriptDestination,
  resolveHooksJsonPath,
};
