'use strict';

// Manages the EGC entries of Kimi Code CLI's config.toml: the Guardian on
// PreToolUse, the session start on SessionStart and the Team Brain push on
// Stop. Kimi declares hooks as [[hooks]] tables that accept exactly four
// keys (event, matcher, command, timeout); an extra key stops the whole
// configuration from loading, so an EGC block carries no name, no type and
// no description and is recognised by the EGC script its command runs. The
// file is edited as text: an EGC block is replaced whole or removed, and
// every other line (the person's own hooks, providers, models) is left byte
// for byte. When the TOML parser is available the result is parsed before
// it is written, and a file the update would break is left untouched.

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
const KIMI_SESSION_START_EVENT = 'kimi:session_start';
const KIMI_STOP_EVENT = 'kimi:stop';
const KIMI_NATIVE_EVENT = 'PreToolUse';
// The event of config.toml each operation event stands for. SessionStart
// is observation only for Kimi (its output is discarded, so the session
// reads the memory through get_state); Stop may block, and the push script
// never does.
const KIMI_NATIVE_EVENTS = Object.freeze({
  [KIMI_PRE_TOOL_EVENT]: KIMI_NATIVE_EVENT,
  [KIMI_SESSION_START_EVENT]: 'SessionStart',
  [KIMI_STOP_EVENT]: 'Stop',
});
const KIMI_CONFIG_FILE_NAME = 'config.toml';
const KIMI_HOOK_TIMEOUT_SECONDS = 30;
// Kimi tests the matcher as an unanchored regular expression against the
// tool name: Bash runs shell commands, Edit and Write change files, and the
// legacy names Shell, WriteFile and StrReplaceFile are the same tools.
const KIMI_GUARDIAN_MATCHER = '^(Bash|Shell|Write|WriteFile|Edit|StrReplaceFile)$';
const BASH_GUARDIAN_HOOK_MODULE_ID = 'egc-bash-guardian-hook';
const GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/kimi-guardian-adapter.js';
const SHELL_EDIT_ADAPTER_SOURCE_RELATIVE_PATH = 'scripts/lib/shell-edit-guardian-adapter.js';
const GUARDIAN_ADAPTER_BASENAME = path.basename(GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);
const KIMI_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/kimi-session-start.js';
const TEAM_SYNC_STOP_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/team-sync-stop.js';
// The EGC scripts a block of config.toml may run, each the mark of its own
// block.
const EGC_SCRIPT_BASENAMES = Object.freeze([
  GUARDIAN_ADAPTER_BASENAME,
  path.basename(KIMI_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH),
  path.basename(TEAM_SYNC_STOP_SCRIPT_SOURCE_RELATIVE_PATH),
]);

const HOOKS_TABLE_HEADER_RE = /^\s*\[\[\s*hooks\s*\]\]\s*(?:#.*)?$/;
const ANY_TABLE_HEADER_RE = /^\s*\[/;
const COMMAND_LINE_RE = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/;
function commandPattern(basename) {
  const escaped = basename.replaceAll('.', String.raw`\.`);
  return new RegExp(String.raw`[\\/]${escaped}"\s*$`);
}
const EGC_COMMAND_PATTERNS = new Map(EGC_SCRIPT_BASENAMES.map(basename => [basename, commandPattern(basename)]));

function resolveKimiConfigTomlPath(targetRoot) {
  return path.join(targetRoot, KIMI_CONFIG_FILE_NAME);
}

function resolveKimiGuardianAdapterDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', GUARDIAN_ADAPTER_BASENAME);
}

// The EGC script a [[hooks]] block runs, by the end of its command, wherever
// that copy sits: a block left by an older install location is a stale copy
// of the same hook, not the person's own. Null for a block of the person's.
function egcScriptOf(command) {
  if (typeof command !== 'string') return null;
  for (const [basename, pattern] of EGC_COMMAND_PATTERNS) {
    if (pattern.test(command)) return basename;
  }
  return null;
}

function isEgcCommand(command) {
  return egcScriptOf(command) !== null;
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

// The block of one EGC hook: a tool event carries its matcher, a session
// event none.
function renderHookBlock(command, matcher, event = KIMI_NATIVE_EVENT) {
  return [
    '[[hooks]]',
    `event = ${tomlString(event)}`,
    ...(matcher === undefined ? [] : [`matcher = ${tomlString(matcher)}`]),
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

// The blocks of one EGC script (by its basename), or of every EGC script
// when none is named.
function egcBlocks(content, basename) {
  const parsed = parseHookBlocks(content);
  const mine = parsed.blocks.filter(block => (
    basename === undefined ? isEgcCommand(block.command) : egcScriptOf(block.command) === basename
  ));
  return { ...parsed, mine };
}

// The content with the block of one EGC script set to exactly `rendered`:
// unchanged when that block is already there as is, otherwise every block
// of that script goes and the new one is appended after everything else;
// the blocks of the other EGC scripts stay where they are.
function upsertHookBlock(content, rendered, basename) {
  const { lines, mine } = egcBlocks(content, basename);
  if (mine.length === 1 && blockText(lines, mine[0]) === rendered) {
    return { content, changed: false };
  }
  const kept = withoutBlocks(lines, mine).join('\n').trimEnd();
  const eol = lineEnding(content);
  const block = rendered.replaceAll('\n', eol);
  return { content: kept ? `${kept}${eol}${eol}${block}${eol}` : `${block}${eol}`, changed: true };
}

function removeHookBlocks(content, basename) {
  const { lines, mine } = egcBlocks(content, basename);
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
 * Writes the block of one EGC hook into config.toml, replacing an older
 * block of the same script and leaving the blocks of the other EGC scripts.
 * @param {string} configTomlPath
 * @param {string} hookScriptPath
 * @param {string} [matcher] for a tool event; a session event takes none
 * @param {string} [event] the event of config.toml, PreToolUse by default
 * @returns {{changed: boolean}}
 */
function applyKimiHookToFile(configTomlPath, hookScriptPath, matcher, event = KIMI_NATIVE_EVENT) {
  const basename = path.basename(String(hookScriptPath));
  if (!EGC_SCRIPT_BASENAMES.includes(basename)) {
    throw new TypeError(`not an EGC hook script for Kimi Code: ${hookScriptPath}`);
  }
  const original = readConfigFile(configTomlPath);
  assertEditable(configTomlPath, original);
  const rendered = renderHookBlock(buildHookCommand(hookScriptPath), matcher, event);
  const { content, changed } = upsertHookBlock(original, rendered, basename);
  if (changed) writeConfigFile(configTomlPath, content);
  return { changed };
}

/**
 * Removes the block of one EGC hook from config.toml (every EGC block when
 * no script is named), leaving every other block and setting as it was.
 * @param {string} configTomlPath
 * @param {string} [hookScriptPath]
 * @returns {{changed: boolean}}
 */
function removeKimiHookFromFile(configTomlPath, hookScriptPath) {
  if (!fs.existsSync(configTomlPath)) return { changed: false };
  const original = readConfigFile(configTomlPath);
  assertEditable(configTomlPath, original);
  const basename = hookScriptPath === undefined ? undefined : path.basename(String(hookScriptPath));
  const { content, changed } = removeHookBlocks(original, basename);
  if (changed) writeConfigFile(configTomlPath, content);
  return { changed };
}

/**
 * Whether config.toml holds the block of one EGC hook exactly as an install
 * writes it. With the matcher or the event the whole block is compared, so
 * a timeout or matcher changed by hand is drift the doctor reports and
 * repair rewrites; with neither (a retirement check) the command decides.
 * @param {string} configTomlPath
 * @param {string} hookScriptPath
 * @param {string} [matcher]
 * @param {string} [event]
 * @returns {'ok'|'drifted'}
 */
function inspectKimiHookFile(configTomlPath, hookScriptPath, matcher, event) {
  const exact = matcher !== undefined || event !== undefined;
  try {
    const command = buildHookCommand(hookScriptPath);
    const { lines, blocks } = parseHookBlocks(readConfigFile(configTomlPath));
    const found = blocks.some(block => (
      block.command === command
      && (!exact || blockText(lines, block) === renderHookBlock(command, matcher, event ?? KIMI_NATIVE_EVENT))
    ));
    return found ? 'ok' : 'drifted';
  } catch {
    return 'drifted';
  }
}

// The handlers claude-settings-hook-handlers.js dispatches a kimi:pre_tool,
// kimi:session_start or kimi:stop operation to.
const KIMI_HOOK_OPERATION_HANDLERS = Object.freeze({
  apply: operation => applyKimiHookToFile(operation.destinationPath, operation.hookScriptPath, operation.hookMatcher, KIMI_NATIVE_EVENTS[operation.hookEvent]),
  remove: operation => removeKimiHookFromFile(operation.destinationPath, operation.hookScriptPath),
  inspect: operation => inspectKimiHookFile(operation.destinationPath, operation.hookScriptPath, operation.hookMatcher, KIMI_NATIVE_EVENTS[operation.hookEvent]),
});

function createKimiHookMergeOperation(targetRoot, { moduleId, sourceRelativePath, hookEvent, hookMatcher, hookScriptPath }) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId,
    sourceRelativePath,
    destinationPath: resolveKimiConfigTomlPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent,
    hookMatcher,
    hookScriptPath,
  };
}

/**
 * The Guardian pre_tool entry of config.toml under targetRoot.
 * @param {string} targetRoot
 * @returns {object}
 */
function createKimiGuardianHookMergeOperation(targetRoot) {
  return createKimiHookMergeOperation(targetRoot, {
    moduleId: BASH_GUARDIAN_HOOK_MODULE_ID,
    sourceRelativePath: GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    hookEvent: KIMI_PRE_TOOL_EVENT,
    hookMatcher: KIMI_GUARDIAN_MATCHER,
    hookScriptPath: resolveKimiGuardianAdapterDestination(targetRoot),
  });
}

/**
 * The two session entries of config.toml under targetRoot: SessionStart
 * runs the Kimi wrapper of the shared host session start (the pull and the
 * restore; Kimi discards the output of this event), Stop runs the shared
 * Team Brain push. Neither takes a matcher.
 * @param {string} targetRoot
 * @returns {Array<object>}
 */
function createKimiSessionHookMergeOperations(targetRoot) {
  const { HOST_SESSION_HOOK_MODULE_ID, resolveTeamSyncStopHookScriptDestination } = require('./claude-settings-hook-copy-operations');
  return [
    createKimiHookMergeOperation(targetRoot, {
      moduleId: HOST_SESSION_HOOK_MODULE_ID,
      sourceRelativePath: KIMI_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH,
      hookEvent: KIMI_SESSION_START_EVENT,
      hookScriptPath: path.join(targetRoot, ...KIMI_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH.split('/')),
    }),
    createKimiHookMergeOperation(targetRoot, {
      moduleId: HOST_SESSION_HOOK_MODULE_ID,
      sourceRelativePath: TEAM_SYNC_STOP_SCRIPT_SOURCE_RELATIVE_PATH,
      hookEvent: KIMI_STOP_EVENT,
      hookScriptPath: resolveTeamSyncStopHookScriptDestination(targetRoot),
    }),
  ];
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
      SHELL_EDIT_ADAPTER_SOURCE_RELATIVE_PATH,
      path.join(targetRoot, ...SHELL_EDIT_ADAPTER_SOURCE_RELATIVE_PATH.split('/')),
      { strategy: 'preserve-relative-path' }
    ),
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
  KIMI_NATIVE_EVENTS,
  KIMI_PRE_TOOL_EVENT,
  KIMI_SESSION_START_EVENT,
  KIMI_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH,
  KIMI_STOP_EVENT,
  applyKimiHookToFile,
  createKimiGuardianHookMergeOperation,
  createKimiGuardianScriptCopyOperations,
  createKimiSessionHookMergeOperations,
  inspectKimiHookFile,
  parseHookBlocks,
  removeKimiHookFromFile,
  renderHookBlock,
  resolveKimiConfigTomlPath,
  resolveKimiGuardianAdapterDestination,
};
