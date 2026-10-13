'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { tomlEscape } = require('./mcp-register-toml-text');

let TOML = null;
try {
  TOML = require('@iarna/toml');
} catch {
  // Without a parser the TOML refresh is skipped and the file stays as it is.
}

const SCRIPT_FILE = /\.[cm]?js$/;

// A registered script that no longer exists on disk (a removed worktree, a
// temporary folder, a previous install location) can only be a leftover:
// the server it names cannot start. A path that still exists is another
// install the person may have chosen, so it is never touched.
function isStaleScript(value, currentBin) {
  return typeof value === 'string'
    && path.isAbsolute(value)
    && SCRIPT_FILE.test(value)
    && value !== currentBin
    && !fs.existsSync(value);
}

// Returns the list with only the stale script element replaced, or null when
// there is nothing to replace. Every other element and key stays as written.
function refreshScriptInList(list, currentBin) {
  if (!Array.isArray(list)) return null;
  const index = list.findIndex(item => isStaleScript(item, currentBin));
  if (index === -1) return null;
  return list.map((item, position) => (position === index ? currentBin : item));
}

// Returns the entry with its stale script path under `key` ("args" or
// "command") replaced by currentBin, or null when the entry is current.
function refreshEntryScript(entry, key, currentBin) {
  if (!entry || typeof entry !== 'object') return null;
  const list = refreshScriptInList(entry[key], currentBin);
  return list ? { ...entry, [key]: list } : null;
}

function serversByName(parsed) {
  const servers = parsed?.mcp_servers;
  if (Array.isArray(servers)) return new Map(servers.map(item => [item?.name, item]));
  if (servers && typeof servers === 'object') return new Map(Object.entries(servers));
  return new Map();
}

// Replaces, in the text of a TOML config, the stale script path of each EGC
// server with the current one, leaving the rest of the text byte for byte as
// it was. Returns the text unchanged when nothing is stale, there is no
// parser, or the edit would not parse back to exactly the intended path.
function refreshTomlScripts(content, bins) {
  if (!TOML) return content;
  let parsed;
  try {
    parsed = TOML.parse(content);
  } catch {
    return content;
  }
  const servers = serversByName(parsed);
  let updated = content;
  for (const [name, currentBin] of [['egc-guardian', bins.guardianBin], ['egc-memory', bins.memoryBin]]) {
    const staleScript = servers.get(name)?.args?.find(item => isStaleScript(item, currentBin));
    if (!staleScript) continue;
    const before = `"${tomlEscape(staleScript)}"`;
    if (!updated.includes(before)) continue;
    updated = updated.replace(before, () => `"${tomlEscape(currentBin)}"`);
  }
  if (updated === content) return content;
  try {
    const reparsed = serversByName(TOML.parse(updated));
    const intact = [['egc-guardian', bins.guardianBin], ['egc-memory', bins.memoryBin]]
      .every(([name, bin]) => !servers.get(name)?.args?.some(item => isStaleScript(item, bin))
        || reparsed.get(name)?.args?.includes(bin));
    return intact ? updated : content;
  } catch {
    return content;
  }
}

module.exports = {
  isStaleScript,
  refreshEntryScript,
  refreshTomlScripts,
};
