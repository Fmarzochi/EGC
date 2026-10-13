'use strict';

const { isDeepStrictEqual } = require('node:util');
const { readFileIfExists, writeConfig } = require('./mcp-register-config-io');
const {
  appendTableServer,
  findInlineMcpServersArray,
  findRemainingLegacyMcpServers,
  removeLegacyTomlServer,
  tomlEscape,
  tomlHasActiveServer,
  tomlHasTableServer,
} = require('./mcp-register-toml-text');
let TOML = null;
try {
  TOML = require('@iarna/toml');
} catch {
  // Handled per-call below: falls back to the substring check.
}

function parsesAsToml(text) {
  if (!TOML) return true;
  try {
    TOML.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Whether the update touched nothing but mcp_servers. Parsing alone is too
// weak a test: a line cut out of a multi-line string, or a key removed from
// under a table header the scan did not recognise, leaves a document that
// still parses and has quietly lost content. Comparing both sides with
// mcp_servers set aside catches exactly that. Without a parser nothing can
// be compared, so the answer is true and the scan stands on its own.
function keepsEverythingElse(original, updated) {
  if (!TOML) return true;
  try {
    const before = TOML.parse(original);
    const after = TOML.parse(updated);
    delete before.mcp_servers;
    delete after.mcp_servers;
    return isDeepStrictEqual(before, after);
  } catch {
    return false;
  }
}

// The keys a tool's [[mcp_servers]] table needs beyond name, command and
// args (Mistral Vibe: transport = "stdio"), one line each, after the name.
function tomlServerLines(keys) {
  return Object.entries(keys || {}).map(([key, value]) => `${key} = "${tomlEscape(value)}"\n`).join('');
}

/**
 * Same idea as registerJson but for TOML configs (Codex CLI, Mistral Vibe).
 * Returns true if the file was appended to, false if both entries were
 * already present.
 *
 * An empty inline `mcp_servers = []` is dropped first: it carries no entries
 * to preserve, and leaving it in place would make the appended
 * [[mcp_servers]] tables invalid TOML. A non-empty one that a parser
 * confirms already holds both servers is a silent no-op - the person
 * followed the error below and added them by hand, and warning again on
 * every run would punish them for doing exactly what they were told; with
 * no parser to confirm it, that case throws like any other. Any other
 * non-empty one throws, the
 * same "left untouched" contract registerJson uses for a file it cannot
 * safely merge into: rewriting it would mean re-serializing entries the
 * person wrote by hand, and appending to it would leave the tool unable to
 * start at all.
 *
 * Whatever the scan concluded, both sides are parsed before anything is
 * written and compared with mcp_servers set aside: an update that would
 * lose any other content is refused and the file is left as it was. An
 * install may leave a tool unregistered, but it must never damage a config.
 */
function registerTablePerServerToml(targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const original = readFileIfExists(targetPath) ?? '';
  let content = original;

  const inlineArray = findInlineMcpServersArray(content);
  if (inlineArray && !inlineArray.isEmpty) {
    if (TOML
      && tomlHasTableServer(content, 'egc-guardian')
      && tomlHasTableServer(content, 'egc-memory')) {
      return false;
    }
    throw new TypeError(
      `existing file at ${targetPath} declares mcp_servers as an inline array - left untouched: ` +
      'rewrite it as [mcp_servers.<id>] tables, or add egc-guardian and egc-memory to it by hand, then re-run'
    );
  }
  if (inlineArray) {
    const lines = content.split('\n');
    lines.splice(inlineArray.start, inlineArray.end - inlineArray.start + 1);
    content = lines.join('\n');
  }

  const hasGuardian = tomlHasTableServer(content, 'egc-guardian');
  const hasMemory = tomlHasTableServer(content, 'egc-memory');
  if (hasGuardian && hasMemory) {
    return false;
  }
  content = removeLegacyTomlServer(content, 'egc-guardian');
  content = removeLegacyTomlServer(content, 'egc-memory');

  const remainingLegacy = findRemainingLegacyMcpServers(content);
  if (remainingLegacy.length > 0) {
    const foreign = remainingLegacy[0];
    throw new TypeError(
      `existing file at ${targetPath} contains legacy [[mcp_servers]] entry "${foreign}" - left untouched: ` +
      `rewrite it as a [mcp_servers.${foreign}] table or add egc-guardian and egc-memory by hand, then re-run`
    );
  }

  const missing = [];
  if (!hasGuardian) missing.push(['egc-guardian', guardianBin]);
  if (!hasMemory) missing.push(['egc-memory', memoryBin]);
  if (missing.length === 0) return false;
  for (const [id, bin] of missing) {
    content = appendTableServer(content, id, bin);
  }
  if (parsesAsToml(original) && !keepsEverythingElse(original, content)) {
    throw new TypeError(
      `existing file at ${targetPath} could not be updated without breaking it - left untouched: ` +
      'add egc-guardian and egc-memory as [mcp_servers.<id>] tables by hand, then re-run'
    );
  }
  writeConfig(targetPath, content);
  return true;
}

function registerToml(targetPath, bins, target = {}) {
  if (target.tomlTables === 'per-server') {
    return registerTablePerServerToml(targetPath, bins);
  }
  const { guardianBin, memoryBin } = bins;
  const extraLines = tomlServerLines(target.tomlServerKeys);
  const original = readFileIfExists(targetPath) ?? '';
  let content = original;

  const inlineArray = findInlineMcpServersArray(content);
  if (inlineArray && !inlineArray.isEmpty) {
    // Only a real parse can confirm the entries are there, and only a parse
    // is asked for: an entry added by hand as the error below asks carries
    // args = ["/path/index.js"], whose inner bracket ends a line-based scan
    // early and hides every entry after it. Without a parser
    // tomlHasActiveServer falls back to a substring search over the whole
    // file, where a comment naming both servers would pass as proof of a
    // registration that does not exist and the install would report nothing
    // to do, so there the honest answer is to refuse instead.
    if (TOML
      && tomlHasActiveServer(content, 'egc-guardian')
      && tomlHasActiveServer(content, 'egc-memory')) {
      return false;
    }
    throw new TypeError(
      `existing file at ${targetPath} declares mcp_servers as an inline array - left untouched: ` +
      'rewrite it as [[mcp_servers]] tables, or add egc-guardian and egc-memory to it by hand, then re-run'
    );
  }
  if (inlineArray) {
    const lines = content.split('\n');
    lines.splice(inlineArray.start, inlineArray.end - inlineArray.start + 1);
    content = lines.join('\n');
  }

  let appended = false;
  if (!tomlHasActiveServer(content, 'egc-guardian')) {
    content += `\n[[mcp_servers]]\nname = "egc-guardian"\n${extraLines}command = "node"\nargs = ["${tomlEscape(guardianBin)}"]\n`;
    appended = true;
  }
  if (!tomlHasActiveServer(content, 'egc-memory')) {
    content += `\n[[mcp_servers]]\nname = "egc-memory"\n${extraLines}command = "node"\nargs = ["${tomlEscape(memoryBin)}"]\n`;
    appended = true;
  }
  if (!appended) return false;
  if (parsesAsToml(original) && !keepsEverythingElse(original, content)) {
    throw new TypeError(
      `existing file at ${targetPath} could not be updated without breaking it - left untouched: ` +
      'add egc-guardian and egc-memory as [[mcp_servers]] tables by hand, then re-run'
    );
  }
  writeConfig(targetPath, content);
  return true;
}

module.exports = {
  registerToml,
};
