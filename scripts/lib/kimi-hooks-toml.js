'use strict';

// Manages the EGC entry of Kimi Code CLI's config.toml. Kimi declares hooks
// as [[hooks]] tables that accept exactly four keys (event, matcher,
// command, timeout); an extra key stops the whole configuration from
// loading, so an EGC block carries no name, no type and no description and
// is recognised by the adapter script its command runs. The file is edited
// as text: an EGC block is replaced whole or removed, and every other line
// (the person's own hooks, providers, models) is left byte for byte. When
// the TOML parser is available the result is parsed before it is written,
// and a file the update would break is left untouched.

const fs = require('node:fs');
const path = require('node:path');

const { buildHookCommand } = require('./flat-hooks-json-merge');
const { tomlString, tomlUnescape } = require('./vibe-hooks-toml');

let TOML = null;
try {
  TOML = require('@iarna/toml');
} catch {
  // The text edit is exact for the EGC block without a parser; only the
  // whole-file check before writing is skipped.
}

const HOOK_OPERATION_KIND = 'merge-claude-settings-hooks';
const KIMI_PRE_TOOL_EVENT = 'kimi:pre_tool';
const KIMI_NATIVE_EVENT = 'PreToolUse';
const KIMI_CONFIG_FILE_NAME = 'config.toml';
const KIMI_HOOK_TIMEOUT_SECONDS = 30;
// Kimi tests the matcher as an unanchored regular expression against the
// tool name: Bash runs shell commands, Edit and Write change files, and the
// legacy names Shell, WriteFile and StrReplaceFile are the same tools.
const KIMI_GUARDIAN_MATCHER = '^(Bash|Shell|Write|WriteFile|Edit|StrReplaceFile)$';
const BASH_GUARDIAN_HOOK_MODULE_ID = 'egc-bash-guardian-hook';
const GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/kimi-guardian-adapter.js';
const GUARDIAN_ADAPTER_BASENAME = path.basename(GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);

const HOOKS_TABLE_HEADER_RE = /^\s*\[\[\s*hooks\s*\]\]\s*(?:#.*)?$/;
const ANY_TABLE_HEADER_RE = /^\s*\[/;
const COMMAND_LINE_RE = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/;
const ADAPTER_BASENAME_PATTERN = GUARDIAN_ADAPTER_BASENAME.replace('.', String.raw`\.`);
const EGC_COMMAND_RE = new RegExp(String.raw`[\\/]${ADAPTER_BASENAME_PATTERN}"\s*$`);

function resolveKimiConfigTomlPath(targetRoot) {
  return path.join(targetRoot, KIMI_CONFIG_FILE_NAME);
}

function resolveKimiGuardianAdapterDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', GUARDIAN_ADAPTER_BASENAME);
}

// A [[hooks]] block is the EGC one when its command ends by running the
// Kimi Guardian adapter, wherever that copy sits: a block left by an older
// install location is a stale copy of the same hook, not the person's own.
function isEgcCommand(command) {
  return typeof command === 'string' && EGC_COMMAND_RE.test(command);
}

// Splits a config.toml into its [[hooks]] blocks: a block runs from its
// header to its last non-blank line before the next table header or the end
// of the file, and carries the command its line declares. Comment lines after
// the last key stay outside the block: they introduce the next table.
function parseHookBlocks(content) {
  const lines = content.split('\n');
  const blocks = [];
  let current = null;
  lines.forEach((line, index) => {
    if (HOOKS_TABLE_HEADER_RE.test(line)) {
      current = { start: index, end: index, command: null };
      blocks.push(current);
      return;
    }
    if (ANY_TABLE_HEADER_RE.test(line)) {
      current = null;
      return;
    }
    if (!current) return;
    const text = line.trim();
    if (text !== '' && !text.startsWith('#')) current.end = index;
    const command = COMMAND_LINE_RE.exec(line);
    if (command) current.command = tomlUnescape(command[1]);
  });
  return { lines, blocks };
}

function renderHookBlock(command, matcher) {
  return [
    '[[hooks]]',
    `event = ${tomlString(KIMI_NATIVE_EVENT)}`,
    `matcher = ${tomlString(matcher)}`,
    `command = ${tomlString(command)}`,
    `timeout = ${KIMI_HOOK_TIMEOUT_SECONDS}`,
  ].join('\n');
}

function blockText(lines, block) {
  return lines.slice(block.start, block.end + 1).map(line => line.replace(/\r$/, '')).join('\n');
}

function lineEnding(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function withoutBlocks(lines, blocks) {
  const dropped = new Set();
  for (const block of blocks) {
    for (let index = block.start; index <= block.end; index += 1) dropped.add(index);
  }
  return lines.filter((_line, index) => !dropped.has(index));
}

function egcBlocks(content) {
  const parsed = parseHookBlocks(content);
  return { ...parsed, mine: parsed.blocks.filter(block => isEgcCommand(block.command)) };
}

// The content with the EGC block set to exactly `rendered`: unchanged when
// that block is already there as is, otherwise every EGC block goes and the
// new one is appended after everything else.
function upsertHookBlock(content, rendered) {
  const { lines, mine } = egcBlocks(content);
  if (mine.length === 1 && blockText(lines, mine[0]) === rendered) {
    return { content, changed: false };
  }
  const kept = withoutBlocks(lines, mine).join('\n').trimEnd();
  const eol = lineEnding(content);
  const block = rendered.replaceAll('\n', eol);
  return { content: kept ? `${kept}${eol}${eol}${block}${eol}` : `${block}${eol}`, changed: true };
}

function removeHookBlocks(content) {
  const { lines, mine } = egcBlocks(content);
  if (mine.length === 0) return { content, changed: false };
  const kept = withoutBlocks(lines, mine).join('\n').trimEnd();
  return { content: kept ? `${kept}${lineEnding(content)}` : '', changed: true };
}

function readConfigFile(configTomlPath) {
  return fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf8') : '';
}

function parsesAsToml(content) {
  if (!TOML) return true;
  try {
    TOML.parse(content);
    return true;
  } catch {
    return false;
  }
}

// An existing file the parser cannot read is never edited: the person has a
// broken configuration to fix first and a write would hide that.
function assertEditable(configTomlPath, original) {
  if (original !== '' && !parsesAsToml(original)) {
    throw new TypeError(`existing file at ${configTomlPath} is not valid TOML - left untouched`);
  }
}

function writeConfigFile(configTomlPath, updated) {
  if (!parsesAsToml(updated)) {
    throw new TypeError(`existing file at ${configTomlPath} could not be updated without breaking it - left untouched`);
  }
  fs.mkdirSync(path.dirname(configTomlPath), { recursive: true });
  fs.writeFileSync(configTomlPath, updated, 'utf8');
}

/**
 * Writes the EGC Guardian hook into config.toml, replacing an older block
 * of the same hook.
 * @param {string} configTomlPath
 * @param {string} hookScriptPath
 * @param {string} matcher
 * @returns {{changed: boolean}}
 */
function applyKimiHookToFile(configTomlPath, hookScriptPath, matcher) {
  if (path.basename(String(hookScriptPath)) !== GUARDIAN_ADAPTER_BASENAME) {
    throw new TypeError(`not an EGC hook script for Kimi Code: ${hookScriptPath}`);
  }
  const original = readConfigFile(configTomlPath);
  assertEditable(configTomlPath, original);
  const rendered = renderHookBlock(buildHookCommand(hookScriptPath), matcher);
  const { content, changed } = upsertHookBlock(original, rendered);
  if (changed) writeConfigFile(configTomlPath, content);
  return { changed };
}

/**
 * Removes the EGC Guardian hook from config.toml, leaving every other
 * block and setting as it was.
 * @param {string} configTomlPath
 * @returns {{changed: boolean}}
 */
function removeKimiHookFromFile(configTomlPath) {
  if (!fs.existsSync(configTomlPath)) return { changed: false };
  const original = readConfigFile(configTomlPath);
  assertEditable(configTomlPath, original);
  const { content, changed } = removeHookBlocks(original);
  if (changed) writeConfigFile(configTomlPath, content);
  return { changed };
}

/**
 * Whether config.toml holds the EGC Guardian hook exactly as an install
 * writes it. With the matcher the whole block is compared, so a timeout or
 * matcher changed by hand is drift the doctor reports and repair rewrites;
 * without it (a retirement check) the command decides.
 * @param {string} configTomlPath
 * @param {string} hookScriptPath
 * @param {string} [matcher]
 * @returns {'ok'|'drifted'}
 */
function inspectKimiHookFile(configTomlPath, hookScriptPath, matcher) {
  try {
    const command = buildHookCommand(hookScriptPath);
    const { lines, blocks } = parseHookBlocks(readConfigFile(configTomlPath));
    const found = blocks.some(block => (
      block.command === command
      && (matcher === undefined || blockText(lines, block) === renderHookBlock(command, matcher))
    ));
    return found ? 'ok' : 'drifted';
  } catch {
    return 'drifted';
  }
}

// The handlers claude-settings-hook-handlers.js dispatches a kimi:pre_tool
// operation to.
const KIMI_HOOK_OPERATION_HANDLERS = Object.freeze({
  apply: operation => applyKimiHookToFile(operation.destinationPath, operation.hookScriptPath, operation.hookMatcher),
  remove: operation => removeKimiHookFromFile(operation.destinationPath),
  inspect: operation => inspectKimiHookFile(operation.destinationPath, operation.hookScriptPath, operation.hookMatcher),
});

/**
 * The Guardian pre_tool entry of config.toml under targetRoot.
 * @param {string} targetRoot
 * @returns {object}
 */
function createKimiGuardianHookMergeOperation(targetRoot) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: BASH_GUARDIAN_HOOK_MODULE_ID,
    sourceRelativePath: GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: resolveKimiConfigTomlPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: KIMI_PRE_TOOL_EVENT,
    hookMatcher: KIMI_GUARDIAN_MATCHER,
    hookScriptPath: resolveKimiGuardianAdapterDestination(targetRoot),
  };
}

/**
 * The copies the Guardian adapter needs next to it under targetRoot: the
 * Bash and write validators, the stdin reader and the adapter itself.
 * @param {Function} createRemappedOperation
 * @param {string} targetRoot
 * @returns {Array<object>}
 */
function createKimiGuardianScriptCopyOperations(createRemappedOperation, targetRoot) {
  const {
    createAdapterStdinJsonCopyOperation,
    createBashGuardianScriptCopyOperations,
    createWriteValidatorScriptCopyOperation,
  } = require('./claude-settings-hooks');
  return [
    ...createBashGuardianScriptCopyOperations(createRemappedOperation, targetRoot),
    createWriteValidatorScriptCopyOperation(createRemappedOperation, targetRoot),
    createAdapterStdinJsonCopyOperation(createRemappedOperation, targetRoot),
    createRemappedOperation(
      BASH_GUARDIAN_HOOK_MODULE_ID,
      GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveKimiGuardianAdapterDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
  ];
}

module.exports = {
  KIMI_CONFIG_FILE_NAME,
  KIMI_GUARDIAN_MATCHER,
  KIMI_HOOK_OPERATION_HANDLERS,
  KIMI_HOOK_TIMEOUT_SECONDS,
  KIMI_PRE_TOOL_EVENT,
  applyKimiHookToFile,
  createKimiGuardianHookMergeOperation,
  createKimiGuardianScriptCopyOperations,
  inspectKimiHookFile,
  parseHookBlocks,
  removeKimiHookFromFile,
  renderHookBlock,
  resolveKimiConfigTomlPath,
  resolveKimiGuardianAdapterDestination,
};
