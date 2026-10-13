'use strict';

const { readFileIfExists, writeConfig } = require('./mcp-register-config-io');
const { refreshEntryScript } = require('./mcp-register-stale');

// js-yaml is required lazily, inside the functions that actually parse or
// dump YAML, not at module load time: a sandbox that copies scripts/lib/
// without node_modules (tests/scripts/bootstrap-cognitive.test.js's fake
// repo) only ever exercises the gate() check on the Goose registration
// target, never the write path, and a top-level require would make that
// sandbox fail to load this module at all.
function loadYaml() {
  return require('js-yaml');
}

/**
 * Parses raw YAML configuration content as an object.
 * Returns {} if content is null, empty, or whitespace-only.
 * Throws if malformed YAML or the root value is not a plain object.
 */
function parseYamlObject(targetPath, rawContent) {
  if (rawContent === null || rawContent === undefined) return {};
  const trimmed = rawContent.trim();
  if (trimmed.length === 0) return {};
  let parsed;
  try {
    parsed = loadYaml().load(trimmed);
  } catch (err) {
    throw new Error(`existing file at ${targetPath} is not valid YAML - left untouched: ${err.message}`, { cause: err });
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`existing file at ${targetPath} is not a valid config object - left untouched`);
  }
  return parsed;
}

/**
 * Merges egc-guardian / egc-memory into Goose's config.yaml `extensions`
 * list, preserving every other top-level key and every other extension.
 * Returns true if the file was created/changed, false if both entries were
 * already present and current (a legitimate, silent no-op).
 *
 * js-yaml's load/dump round-trip keeps every key and value, but it is not
 * comment-preserving: a comment in the person's own config.yaml does not
 * survive a write that touches this file. That is a known, documented
 * tradeoff (no comment-safe YAML writer exists in this codebase yet), not a
 * silent one -- unlike registerJson/registerToml, which only edit the exact
 * bytes they need to.
 */
function registerGooseYaml(targetPath, bins) {
  const { guardianBin, memoryBin } = bins;
  const existingContent = readFileIfExists(targetPath);
  const obj = parseYamlObject(targetPath, existingContent);
  if (obj.extensions === null || obj.extensions === undefined) {
    obj.extensions = [];
  } else if (!Array.isArray(obj.extensions)) {
    throw new TypeError(`existing file at ${targetPath} has an invalid extensions list - left untouched`);
  }

  let changed = false;
  for (const [name, bin] of [['egc-guardian', guardianBin], ['egc-memory', memoryBin]]) {
    const index = obj.extensions.findIndex(ext => ext && ext.name === name);
    if (index === -1) {
      obj.extensions.push({ name, enabled: true, transport: { type: 'stdio', command: 'node', args: [bin] } });
      changed = true;
      continue;
    }
    const current = obj.extensions[index];
    const refreshedTransport = refreshEntryScript(current.transport, 'args', bin);
    if (refreshedTransport) {
      obj.extensions[index] = { ...current, transport: refreshedTransport };
      changed = true;
    }
  }

  if (!changed) return false;
  writeConfig(targetPath, loadYaml().dump(obj, { lineWidth: -1 }));
  return true;
}

module.exports = { parseYamlObject, registerGooseYaml };
