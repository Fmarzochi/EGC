'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isSymbolicLink, readFileIfExists, writeConfig } = require('./mcp-register-config-io');
const { refreshEntryScript } = require('./mcp-register-stale');

/**
 * Parses raw JSON configuration content as an object.
 * Returns {} if content is null, empty, or whitespace-only.
 * Throws SyntaxError wrapped in Error if malformed JSON.
 * Throws TypeError if the root value is not an object or is an array.
 */
function parseJsonObject(targetPath, rawContent, rootEntityName = 'config') {
  if (rawContent === null || rawContent === undefined) return {};
  const trimmed = rawContent.trim();
  if (trimmed.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`existing file at ${targetPath} is not valid JSON - left untouched: ${err.message}`, { cause: err });
    }
    throw err;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`existing file at ${targetPath} is not a valid ${rootEntityName} object - left untouched`);
  }
  return parsed;
}

/**
 * Merges egc-guardian / egc-memory into a JSON mcpServers config, preserving
 * whatever else is already in the file. Returns true if the file was
 * created/changed, false if both entries were already present (a legitimate,
 * silent no-op). Throws if the existing file can't be parsed as JSON -
 * that's not a no-op, it's a reason the config wasn't touched, and the two
 * need to stay distinguishable so a caller can warn on one and stay quiet
 * on the other.
 */
function registerJson(targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const existingContent = readFileIfExists(targetPath);
  const obj = parseJsonObject(targetPath, existingContent, 'MCP config');
  if (obj.mcpServers === null || obj.mcpServers === undefined) {
    obj.mcpServers = {};
  } else if (typeof obj.mcpServers !== 'object' || Array.isArray(obj.mcpServers)) {
    throw new TypeError(`existing file at ${targetPath} has an invalid mcpServers object - left untouched`);
  }
  let changed = false;
  for (const [name, bin] of [['egc-guardian', guardianBin], ['egc-memory', memoryBin]]) {
    const current = obj.mcpServers[name];
    if (!current) {
      obj.mcpServers[name] = { command: 'node', args: [bin] };
      changed = true;
      continue;
    }
    const refreshed = refreshEntryScript(current, 'args', bin);
    if (refreshed) {
      obj.mcpServers[name] = refreshed;
      changed = true;
    }
  }
  if (!changed) return false;
  writeConfig(targetPath, JSON.stringify(obj, null, 2) + '\n');
  return true;
}

function hasEntries(value) {
  return Boolean(value) && Object.keys(value).length > 0;
}

function migrateLegacyZedServer(template, existing) {
  return {
    ...template,
    ...(hasEntries(existing.command.env) ? { env: existing.command.env } : {}),
    ...(hasEntries(existing.settings) ? { settings: existing.settings } : {})
  };
}

/**
 * Merges egc-guardian / egc-memory into Zed's settings.json under the
 * context_servers key. Reads mcp-configs/zed-context-servers.json as a
 * template, substitutes __GUARDIAN_BIN__ and __MEMORY_BIN__ with the
 * resolved paths, then merges the result into the existing settings file
 * without overwriting unrelated keys. Returns true if changed.
 */
function registerZedContextServers(targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const templatePath = path.join(__dirname, '..', '..', 'mcp-configs', 'zed-context-servers.json');
  // The placeholders sit inside JSON string literals, so a Windows bin path's
  // backslashes (C:\Users\...) must be escaped before substitution or the
  // JSON.parse below throws on the invalid "\U" escape. jsonStringBody yields
  // the escaped body of a JSON string without its surrounding quotes.
  const jsonStringBody = (p) => JSON.stringify(p).slice(1, -1);
  const template = fs.readFileSync(templatePath, 'utf8')
    .replaceAll('__GUARDIAN_BIN__', jsonStringBody(guardianBin))
    .replaceAll('__MEMORY_BIN__', jsonStringBody(memoryBin));
  const incoming = JSON.parse(template);

  const existingContent = readFileIfExists(targetPath);
  const settings = parseJsonObject(targetPath, existingContent, 'settings');
  if (settings.context_servers === null || settings.context_servers === undefined) {
    settings.context_servers = {};
  } else if (typeof settings.context_servers !== 'object' || Array.isArray(settings.context_servers)) {
    throw new TypeError(`existing file at ${targetPath} has an invalid context_servers object - left untouched`);
  }
  let changed = false;
  for (const [key, value] of Object.entries(incoming.context_servers)) {
    const existing = settings.context_servers[key];
    const isLegacyShape = existing && typeof existing.command === 'object' && existing.command !== null;
    if (existing && !isLegacyShape) {
      const refreshed = refreshEntryScript(existing, 'args', value.args[0]);
      if (refreshed) {
        settings.context_servers[key] = refreshed;
        changed = true;
      }
      continue;
    }
    settings.context_servers[key] = isLegacyShape ? migrateLegacyZedServer(value, existing) : value;
    changed = true;
  }
  if (!changed) return false;
  writeConfig(targetPath, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

const EGC_SERVER_NAMES = ['egc-guardian', 'egc-memory'];

// An mcpServers block in an OpenCode file is dead weight: OpenCode never
// reads that key, and an older EGC is the only thing that wrote it there.
// Our two entries are removed from it; anything the person added stays,
// and the key goes away once it is empty.
function dropStaleEgcServers(obj) {
  const stale = obj.mcpServers;
  if (!stale || typeof stale !== 'object' || Array.isArray(stale)) return false;
  let changed = false;
  for (const name of EGC_SERVER_NAMES) {
    if (name in stale) { delete stale[name]; changed = true; }
  }
  if (Object.keys(stale).length === 0) { delete obj.mcpServers; changed = true; }
  return changed;
}

/**
 * Merges egc-guardian / egc-memory into an OpenCode config under the `mcp`
 * key, in OpenCode's own shape ({ type: "local", command: [...] }), leaving
 * every other key as it was. Also retires an `mcpServers` block an older
 * EGC left behind, which OpenCode never read (#1405). Returns true if the
 * file was written.
 */
function registerOpenCodeMcp(targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const existingContent = readFileIfExists(targetPath);
  const obj = parseJsonObject(targetPath, existingContent, 'OpenCode config');
  if (obj.mcp === null || obj.mcp === undefined) {
    obj.mcp = {};
  } else if (typeof obj.mcp !== 'object' || Array.isArray(obj.mcp)) {
    throw new TypeError(`existing file at ${targetPath} has an invalid mcp object - left untouched`);
  }
  let changed = false;
  const incoming = {
    'egc-guardian': { type: 'local', command: ['node', guardianBin] },
    'egc-memory': { type: 'local', command: ['node', memoryBin] },
  };
  for (const [name, entry] of Object.entries(incoming)) {
    // Presence, not truthiness: an entry the person set to null or false
    // is theirs to keep, whatever OpenCode makes of it.
    if (!Object.hasOwn(obj.mcp, name)) {
      obj.mcp[name] = entry;
      changed = true;
      continue;
    }
    const refreshed = refreshEntryScript(obj.mcp[name], 'command', entry.command[1]);
    if (refreshed) {
      obj.mcp[name] = refreshed;
      changed = true;
    }
  }
  if (dropStaleEgcServers(obj)) changed = true;
  if (changed) {
    writeConfig(targetPath, JSON.stringify(obj, null, 2) + '\n');
  }
  const siblingChanged = retireStaleLegacySibling(targetPath);
  return changed || siblingChanged;
}

// When the servers go into opencode.json and a legacy config.json sits next
// to it, the mcpServers block an older EGC may have left in that legacy file
// is retired too (our entries only; the rest of the file is left as it is).
// OpenCode merges both files, so the entries written above reach it either
// way. A legacy file that is a link, or that cannot be parsed, is left
// alone: it is not the file being registered into.
function retireStaleLegacySibling(targetPath) {
  if (path.basename(targetPath) !== 'opencode.json') return false;
  const legacyPath = path.join(path.dirname(targetPath), 'config.json');
  if (isSymbolicLink(legacyPath)) return false;
  const content = readFileIfExists(legacyPath);
  if (content === null || content === undefined) return false;
  let legacy;
  try {
    legacy = parseJsonObject(legacyPath, content, 'OpenCode config');
  } catch {
    return false;
  }
  if (!dropStaleEgcServers(legacy)) return false;
  writeConfig(legacyPath, JSON.stringify(legacy, null, 2) + '\n');
  return true;
}

/**
 * Merges egc-guardian / egc-memory into a Crush config under the `mcp`
 * key, in Crush's own shape ({ type: "stdio", command: "node", args: [...] }),
 * leaving every other key as it was. Returns true if the file was written.
 */
function registerCrushMcp(targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const existingContent = readFileIfExists(targetPath);
  const obj = parseJsonObject(targetPath, existingContent, 'Crush config');
  if (obj.mcp === null || obj.mcp === undefined) {
    obj.mcp = {};
  } else if (typeof obj.mcp !== 'object' || Array.isArray(obj.mcp)) {
    throw new TypeError(`existing file at ${targetPath} has an invalid mcp object - left untouched`);
  }
  let changed = false;
  const incoming = {
    'egc-guardian': { type: 'stdio', command: 'node', args: [guardianBin] },
    'egc-memory': { type: 'stdio', command: 'node', args: [memoryBin] },
  };
  for (const [name, entry] of Object.entries(incoming)) {
    if (!Object.hasOwn(obj.mcp, name)) {
      obj.mcp[name] = entry;
      changed = true;
      continue;
    }
    const refreshed = refreshEntryScript(obj.mcp[name], 'args', entry.args[0]);
    if (refreshed) {
      obj.mcp[name] = refreshed;
      changed = true;
    }
  }
  if (changed) {
    writeConfig(targetPath, JSON.stringify(obj, null, 2) + '\n');
  }
  return changed;
}

module.exports = {
  parseJsonObject,
  registerJson,
  registerZedContextServers,
  registerOpenCodeMcp,
  registerCrushMcp,
};
