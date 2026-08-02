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

// deniedCommands is a plain string[] with no per-entry ownership marker, so
// without this record uninstall cannot tell "EGC added rm" apart from "the
// user already denied rm before EGC ever ran" -- and would delete the
// user's own pre-existing entry on uninstall (real finding from cubic
// review, PR #1122). Recorded under its own EGC-namespaced key in the same
// settings.json, so no new install-state schema or separate state file is
// needed; VS Code ignores settings keys it does not recognize.
const SEEDED_BY_EGC_KEY = 'egc.roocodeGuardianDenylistSeeded';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// .vscode/settings.json is JSONC, not plain JSON: VS Code itself accepts
// `//` and `/* */` comments and trailing commas there, and users routinely
// have them in a hand-edited workspace settings file. Strict JSON.parse
// would throw on any of that, taking down install/repair/uninstall for a
// realistic file. Strip comments and trailing commas first (string-aware,
// so `"a // not a comment"` survives intact), matching JSONC's actual
// grammar without pulling in a parser dependency for this one call site.
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === '\n') { inLineComment = false; out += ch; }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next; i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    out += ch;
  }
  // String-aware: a string value containing a literal ",]" or ",}" (e.g. a
  // user's note field quoting JSON syntax) must not be mistaken for an
  // actual trailing comma. Alternates between skipping whole string
  // literals untouched and collapsing a real trailing comma.
  return out.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, trailing) => (
    trailing === undefined ? match : trailing
  ));
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
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (error) {
    throw new Error(`Failed to parse Roo Code settings at ${settingsPath}: ${error.message}`, { cause: error });
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid Roo Code settings at ${settingsPath}: expected a JSON object`);
  }
  return parsed;
}

// Known, accepted trade-off (cubic review, PR #1122): re-serializing with
// JSON.stringify drops comments and original formatting. This already held
// for any plain (uncommented) settings.json before the JSONC-tolerant read
// above existed. What changed is that a *commented* file now also gets
// this same reformat on write instead of the whole operation throwing and
// leaving the file untouched -- accepted rather than building a full
// comment-preserving JSONC editor for this one narrow denylist-seeding
// call site.
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
// Every command actually added this way (never one that was already
// present) is recorded under SEEDED_BY_EGC_KEY so uninstall can undo
// exactly what EGC put there, nothing the user already had.
function addRoocodeDenylistEntries(settings) {
  const base = isPlainObject(settings) ? settings : {};
  const existing = Array.isArray(base[DENIED_COMMANDS_KEY]) ? base[DENIED_COMMANDS_KEY] : [];
  const missing = DANGEROUS_COMMANDS.filter(cmd => !existing.includes(cmd));
  const alreadySeeded = Array.isArray(base[SEEDED_BY_EGC_KEY]) ? base[SEEDED_BY_EGC_KEY] : [];
  const nextSeeded = [...new Set([...alreadySeeded, ...missing])];
  if (missing.length === 0 && nextSeeded.length === alreadySeeded.length) {
    return { settings: base, changed: false };
  }
  return {
    settings: {
      ...base,
      [DENIED_COMMANDS_KEY]: [...existing, ...missing],
      [SEEDED_BY_EGC_KEY]: nextSeeded,
    },
    changed: true,
  };
}

// Removes only the entries SEEDED_BY_EGC_KEY says EGC itself added, never a
// command the user already denied before EGC touched this file (even if it
// happens to also be in DANGEROUS_COMMANDS). A file with dangerous commands
// present but no seeded record at all -- e.g. hand-written, or predating
// this fix -- is left untouched: without provenance there is no safe way to
// tell what EGC would have added, so the conservative default is to remove
// nothing rather than guess.
function removeRoocodeDenylistEntries(settings) {
  const base = isPlainObject(settings) ? settings : {};
  const existing = Array.isArray(base[DENIED_COMMANDS_KEY]) ? base[DENIED_COMMANDS_KEY] : [];
  const seeded = Array.isArray(base[SEEDED_BY_EGC_KEY]) ? base[SEEDED_BY_EGC_KEY] : [];
  const hadSeededKey = SEEDED_BY_EGC_KEY in base;
  const next = existing.filter(cmd => !seeded.includes(cmd));
  if (next.length === existing.length && !hadSeededKey) {
    return { settings: base, changed: false };
  }
  const updated = { ...base };
  if (next.length === 0) {
    delete updated[DENIED_COMMANDS_KEY];
  } else {
    updated[DENIED_COMMANDS_KEY] = next;
  }
  delete updated[SEEDED_BY_EGC_KEY];
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
  SEEDED_BY_EGC_KEY,
  addRoocodeDenylistEntries,
  applyRoocodeDenylistToFile,
  hasRoocodeDenylistEntries,
  inspectRoocodeDenylistFile,
  removeRoocodeDenylistEntries,
  removeRoocodeDenylistFromFile,
  resolveVsCodeSettingsPath,
};
