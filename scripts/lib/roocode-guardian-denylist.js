'use strict';

// Roo Code (RooCodeInc/Roo-Code, a VS Code extension) has no external
// hook API: confirmed against its own docs (docs.roocode.com/features/
// auto-approving-actions) and issue #12025 ("Run hook command on events
// requiring prompts"), which is an open feature request, not shipped.
// There is no way to shell out to pre-bash-guardian-validate.js the way
// every other host here does -- so this is not a Guardian adapter, it is
// the closest real substitute: seeding Roo Code's own native
// `roo-cline.deniedCommands` setting (docs.roocode.com/features/
// auto-approving-actions) with the same unconditionally-dangerous base
// commands Guardian itself hard-blocks regardless of arguments (see
// `DANGEROUS` in mcp/servers/egc-guardian/src/validator.ts). Context-aware
// checks (docker --privileged, gh api -X DELETE, prisma db execute, ...)
// cannot be replicated this way: Roo Code's list is plain command-prefix
// matching ("longest-prefix wins" per its docs), not a script that can
// inspect arguments. This is a real but partial mitigation, not parity.
//
// Settings live in the workspace's own .vscode/settings.json -- confirmed
// via the same docs page, which documents the field directly under a VS
// Code settings key, not a Roo Code-specific config file.

const fs = require('node:fs');
const path = require('node:path');

// Must stay in sync with the `DANGEROUS` export in
// mcp/servers/egc-guardian/src/validator.ts -- the source of truth for
// which base commands Guardian hard-blocks unconditionally. Duplicated
// here (not imported) because that file is TypeScript compiled into the
// egc-guardian MCP server's own build, not reachable from these plain
// Node scripts.
const DANGEROUS_COMMANDS = ['rm', 'mv', 'dd', 'shred', 'truncate'];

// Synthetic dispatch tag: Roo Code has no real "hook event" concept, but
// this reuses claude-settings-hooks.js's operation.hookEvent-keyed dispatch
// (the same mechanism every other host's bespoke merge function is routed
// through) so this integration does not need its own top-level operation
// kind or executor wiring.
const ROOCODE_DENYLIST_TAG = 'roocode-denied-commands';
const DENIED_COMMANDS_KEY = 'roo-cline.deniedCommands';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
    throw new Error(`Failed to parse Roo Code settings at ${settingsPath}: ${error.message}`, { cause: error });
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid Roo Code settings at ${settingsPath}: expected a JSON object`);
  }
  return parsed;
}

function writeSettingsFile(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function resolveVsCodeSettingsPath(projectRoot) {
  return path.join(projectRoot, '.vscode', 'settings.json');
}

// Union, never replace: a user's own deniedCommands entries (if any) are
// always preserved. Only the DANGEROUS_COMMANDS missing from the current
// array are appended, in stable order, so repeat installs are idempotent.
function addRoocodeDenylistEntries(settings) {
  const base = isPlainObject(settings) ? settings : {};
  const existing = Array.isArray(base[DENIED_COMMANDS_KEY]) ? base[DENIED_COMMANDS_KEY] : [];
  const missing = DANGEROUS_COMMANDS.filter(cmd => !existing.includes(cmd));
  if (missing.length === 0) {
    return { settings: base, changed: false };
  }
  return {
    settings: { ...base, [DENIED_COMMANDS_KEY]: [...existing, ...missing] },
    changed: true,
  };
}

function removeRoocodeDenylistEntries(settings) {
  const base = isPlainObject(settings) ? settings : {};
  const existing = Array.isArray(base[DENIED_COMMANDS_KEY]) ? base[DENIED_COMMANDS_KEY] : [];
  const next = existing.filter(cmd => !DANGEROUS_COMMANDS.includes(cmd));
  if (next.length === existing.length) {
    return { settings: base, changed: false };
  }
  const updated = { ...base };
  if (next.length === 0) {
    delete updated[DENIED_COMMANDS_KEY];
  } else {
    updated[DENIED_COMMANDS_KEY] = next;
  }
  return { settings: updated, changed: true };
}

function hasRoocodeDenylistEntries(settings) {
  const base = isPlainObject(settings) ? settings : {};
  const existing = Array.isArray(base[DENIED_COMMANDS_KEY]) ? base[DENIED_COMMANDS_KEY] : [];
  return DANGEROUS_COMMANDS.every(cmd => existing.includes(cmd));
}

function applyRoocodeDenylistToFile(settingsPath) {
  const current = readSettingsFile(settingsPath);
  const { settings, changed } = addRoocodeDenylistEntries(current);
  if (changed) {
    writeSettingsFile(settingsPath, settings);
  }
  return { changed };
}

function removeRoocodeDenylistFromFile(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return { changed: false };
  }
  const current = readSettingsFile(settingsPath);
  const { settings, changed } = removeRoocodeDenylistEntries(current);
  if (changed) {
    writeSettingsFile(settingsPath, settings);
  }
  return { changed };
}

function inspectRoocodeDenylistFile(settingsPath) {
  try {
    return hasRoocodeDenylistEntries(readSettingsFile(settingsPath)) ? 'ok' : 'drifted';
  } catch {
    return 'drifted';
  }
}

module.exports = {
  DANGEROUS_COMMANDS,
  DENIED_COMMANDS_KEY,
  ROOCODE_DENYLIST_TAG,
  addRoocodeDenylistEntries,
  applyRoocodeDenylistToFile,
  hasRoocodeDenylistEntries,
  inspectRoocodeDenylistFile,
  removeRoocodeDenylistEntries,
  removeRoocodeDenylistFromFile,
  resolveVsCodeSettingsPath,
};
