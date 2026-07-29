'use strict';

// Shared merge/read/write primitives for "flat {hooks: {<event>:
// [{command}]}}" hook config files -- the shape used by Windsurf's
// hooks.json and Cursor's .cursor/hooks.json alike (no matcher/group
// wrapper, no "type": "command" field like Claude Code's settings.json).
// Both hosts need the same idempotent, array-preserving merge logic
// instead of claude-settings-hooks.js's addHookEntry() or a generic
// deep-merge-json strategy (which replaces arrays wholesale and would
// clobber a user's other entries in the same event array).

const fs = require('node:fs');
const path = require('node:path');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildHookCommand(scriptPath) {
  return `"${process.execPath}" "${scriptPath}"`; // NOSONAR jssecurity:S8705
}

function readFlatHooksFile(hooksJsonPath, hostLabel) {
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
    throw new Error(`Failed to parse ${hostLabel} hooks config at ${hooksJsonPath}: ${error.message}`, { cause: error });
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid ${hostLabel} hooks config at ${hooksJsonPath}: expected a JSON object`);
  }
  return parsed;
}

function writeFlatHooksFile(hooksJsonPath, config) {
  fs.mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
  fs.writeFileSync(hooksJsonPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function isEgcEntry(entry, command) {
  return isPlainObject(entry) && entry.command === command;
}

// isOwnBasename: (command: string) => boolean, lets each host decide which
// basenames identify ITS OWN managed adapter scripts (Windsurf has two:
// GateGuard + Guardian; Cursor has one: Guardian only).
function isStaleEgcEntry(entry, command, isOwnBasename) {
  if (!isPlainObject(entry) || typeof entry.command !== 'string' || entry.command === command) {
    return false;
  }
  return isOwnBasename(entry.command);
}

// buildExtraTopLevel: (base: object) => object, merged into the result
// alongside `hooks` -- e.g. Cursor's {version} field, which Windsurf's
// hooks.json does not have.
// extraEntryFields: object merged into a newly-appended entry alongside
// `command` -- e.g. Kiro's {matcher: 'execute_bash'}, needed because its
// preToolUse array covers every tool (fs_read, fs_write, execute_bash), not
// just shell commands the way Cursor's beforeShellExecution already is.
function addFlatHookEntry(config, event, command, { isOwnBasename, buildExtraTopLevel, extraEntryFields } = {}) {
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
    if (!migrated && isOwnBasename && isStaleEgcEntry(entry, command, isOwnBasename)) {
      migrated = true;
      return { ...entry, command };
    }
    return entry;
  });

  if (!migrated) {
    nextEntries.push({ ...(extraEntryFields || {}), command });
  }

  hooks[event] = nextEntries;
  const extraTopLevel = buildExtraTopLevel ? buildExtraTopLevel(base) : {};
  return { config: { ...base, ...extraTopLevel, hooks }, changed: true };
}

function applyFlatHookToFile(hooksJsonPath, hostLabel, event, command, options) {
  const current = readFlatHooksFile(hooksJsonPath, hostLabel);
  const { config, changed } = addFlatHookEntry(current, event, command, options);
  if (changed) {
    writeFlatHooksFile(hooksJsonPath, config);
  }
  return { changed };
}

// Pure counterpart to addFlatHookEntry: drops only the EGC-managed entry
// (matched by exact command) from hooks[event], leaving every other entry
// (third-party hooks, other events) untouched. Deletes the event key
// entirely once it is empty, rather than leaving a dangling `[]` behind.
function removeFlatHookEntry(config, event, command) {
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

function removeFlatHookFromFile(hooksJsonPath, hostLabel, event, command) {
  if (!fs.existsSync(hooksJsonPath)) {
    return { changed: false };
  }
  const current = readFlatHooksFile(hooksJsonPath, hostLabel);
  const { config, changed } = removeFlatHookEntry(current, event, command);
  if (changed) {
    writeFlatHooksFile(hooksJsonPath, config);
  }
  return { changed };
}

function inspectFlatHookFile(hooksJsonPath, hostLabel, event, command) {
  try {
    const current = readFlatHooksFile(hooksJsonPath, hostLabel);
    const hooks = isPlainObject(current.hooks) ? current.hooks : {};
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    return existing.some(entry => isEgcEntry(entry, command)) ? 'ok' : 'drifted';
  } catch {
    return 'drifted';
  }
}

module.exports = {
  addFlatHookEntry,
  applyFlatHookToFile,
  buildHookCommand,
  inspectFlatHookFile,
  isEgcEntry,
  isPlainObject,
  isStaleEgcEntry,
  readFlatHooksFile,
  removeFlatHookEntry,
  removeFlatHookFromFile,
  writeFlatHooksFile,
};
