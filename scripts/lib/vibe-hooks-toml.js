'use strict';

// Manages the EGC entries of Mistral Vibe's hooks.toml. Vibe declares hooks
// as [[hooks]] tables (name, type, match, command, timeout, strict,
// description), loads <project>/.vibe/hooks.toml before ~/.vibe/hooks.toml,
// and a hook of the same name in both files resolves to the project entry.
// The file is edited as text: an EGC block is found by its name, replaced
// whole or removed, and every other line is left byte for byte, so a hook
// the person wrote survives every install, repair and uninstall. When the
// TOML parser is available the result is parsed before it is written, and
// a file the update would break is left untouched.

const fs = require('node:fs');
const path = require('node:path');

const { buildHookCommand } = require('./flat-hooks-json-merge');

let TOML = null;
try {
  TOML = require('@iarna/toml');
} catch {
  // The text edit is exact for the EGC blocks without a parser; only the
  // whole-file check before writing is skipped.
}

const HOOK_OPERATION_KIND = 'merge-claude-settings-hooks';
const VIBE_PRE_TOOL_EVENT = 'vibe:pre_tool';
const VIBE_HOOKS_FILE_NAME = 'hooks.toml';
const VIBE_GUARDIAN_HOOK_NAME = 'egc-guardian';
const VIBE_CRUSHER_HOOK_NAME = 'egc-crusher';
// Vibe names a tool after its class in snake_case: Bash, GitBash,
// ExperimentalBash and ExperimentalGitBash run shell commands (the Git Bash
// pair on Windows), Edit writes files. The re: prefix makes the matcher a
// regular expression.
const VIBE_SHELL_TOOLS = 'bash|git_bash|experimental_bash|experimental_git_bash';
const VIBE_GUARDIAN_MATCHER = `re:^(${VIBE_SHELL_TOOLS}|edit)$`;
const VIBE_CRUSHER_MATCHER = `re:^(${VIBE_SHELL_TOOLS})$`;
const BASH_GUARDIAN_HOOK_MODULE_ID = 'egc-bash-guardian-hook';
const CRUSHER_HOOK_MODULE_ID = 'egc-crusher-hook';
const GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/vibe-guardian-adapter.js';
const CRUSHER_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/vibe-crusher-adapter.js';
const GUARDIAN_ADAPTER_BASENAME = path.basename(GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);
const CRUSHER_ADAPTER_BASENAME = path.basename(CRUSHER_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);

// The two EGC hooks by name. The Guardian is strict: a failure of the
// adapter itself denies the call instead of letting it through. The Crusher
// is not: a failure runs the original command.
const EGC_HOOKS = Object.freeze({
  [VIBE_GUARDIAN_HOOK_NAME]: Object.freeze({
    strict: true,
    description: 'EGC Guardian: validates every shell command and file edit before it runs.',
  }),
  [VIBE_CRUSHER_HOOK_NAME]: Object.freeze({
    strict: false,
    description: 'EGC Token Crusher: routes a noisy shell command through egc run.',
  }),
});

const HOOKS_TABLE_HEADER_RE = /^\s*\[\[\s*hooks\s*\]\]\s*(?:#.*)?$/;
const ANY_TABLE_HEADER_RE = /^\s*\[/;
const NAME_LINE_RE = /^\s*name\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/;
const COMMAND_LINE_RE = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/;
const MATCH_LINE_RE = /^\s*match\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/;

// TOML basic strings: a backslash, a quote and every control character are
// escaped, so a path with a newline or a tab still gives a file Vibe parses.
const TOML_ESCAPES = Object.freeze({ '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' });
const TOML_UNESCAPES = Object.freeze({ b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' });

function tomlCharacter(character) {
  if (character === '\\') return '\\\\';
  if (character === '"') return '\\"';
  const code = character.charCodeAt(0);
  if (code >= 0x20 && code !== 0x7f) return character;
  return TOML_ESCAPES[character] || ('\\u' + code.toString(16).padStart(4, '0'));
}

function tomlString(value) {
  return '"' + Array.from(String(value), tomlCharacter).join('') + '"';
}

function tomlUnescape(value) {
  return value.replace(/\\(u[0-9a-fA-F]{4}|[btnfr"\\])/g, (_match, code) => (
    code.startsWith('u') ? String.fromCharCode(Number.parseInt(code.slice(1), 16)) : TOML_UNESCAPES[code]
  ));
}

function resolveVibeHooksTomlPath(targetRoot) {
  return path.join(targetRoot, VIBE_HOOKS_FILE_NAME);
}

function resolveVibeGuardianAdapterDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', GUARDIAN_ADAPTER_BASENAME);
}

function resolveVibeCrusherAdapterDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', CRUSHER_ADAPTER_BASENAME);
}

// The EGC hook a script path stands for, by the adapter's file name: the
// install state keeps the script path of every hook entry, not its name.
function hookNameOfScript(hookScriptPath) {
  const base = path.basename(String(hookScriptPath));
  if (base === GUARDIAN_ADAPTER_BASENAME) return VIBE_GUARDIAN_HOOK_NAME;
  if (base === CRUSHER_ADAPTER_BASENAME) return VIBE_CRUSHER_HOOK_NAME;
  return null;
}

// Splits a hooks.toml into its [[hooks]] blocks: a block runs from its
// header to its last non-blank line before the next table header or the end
// of the file, and carries the name, command and match its lines declare.
function parseHookBlocks(content) {
  const lines = content.split('\n');
  const blocks = [];
  let current = null;
  lines.forEach((line, index) => {
    if (HOOKS_TABLE_HEADER_RE.test(line)) {
      current = { start: index, end: index, name: null, command: null, match: null };
      blocks.push(current);
      return;
    }
    if (ANY_TABLE_HEADER_RE.test(line)) {
      current = null;
      return;
    }
    if (!current) return;
    if (line.trim() !== '') current.end = index;
    const name = NAME_LINE_RE.exec(line);
    if (name) current.name = name[1] ?? name[2];
    const command = COMMAND_LINE_RE.exec(line);
    if (command) current.command = tomlUnescape(command[1]);
    const match = MATCH_LINE_RE.exec(line);
    if (match) current.match = tomlUnescape(match[1]);
  });
  return { lines, blocks };
}

function renderHookBlock(name, command, matcher) {
  const hook = EGC_HOOKS[name];
  return [
    '[[hooks]]',
    `name = ${tomlString(name)}`,
    'type = "pre_tool"',
    `match = ${tomlString(matcher)}`,
    `command = ${tomlString(command)}`,
    `strict = ${hook.strict ? 'true' : 'false'}`,
    `description = ${tomlString(hook.description)}`,
  ].join('\n');
}

function withoutBlocks(lines, blocks) {
  const dropped = new Set();
  for (const block of blocks) {
    for (let index = block.start; index <= block.end; index += 1) dropped.add(index);
  }
  return lines.filter((_line, index) => !dropped.has(index));
}

// The content with the EGC block of `name` set to exactly `rendered`:
// unchanged when that block is already there as is, otherwise the old block
// goes and the new one is appended after everything else.
function upsertHookBlock(content, name, rendered) {
  const { lines, blocks } = parseHookBlocks(content);
  const mine = blocks.filter(block => block.name === name);
  if (mine.length === 1 && lines.slice(mine[0].start, mine[0].end + 1).join('\n') === rendered) {
    return { content, changed: false };
  }
  const kept = withoutBlocks(lines, mine).join('\n').trimEnd();
  return { content: kept ? `${kept}\n\n${rendered}\n` : `${rendered}\n`, changed: true };
}

function removeHookBlocks(content, name) {
  const { lines, blocks } = parseHookBlocks(content);
  const mine = blocks.filter(block => block.name === name);
  if (mine.length === 0) return { content, changed: false };
  const kept = withoutBlocks(lines, mine).join('\n').trimEnd();
  return { content: kept ? `${kept}\n` : '', changed: true };
}

function readHooksFile(hooksTomlPath) {
  return fs.existsSync(hooksTomlPath) ? fs.readFileSync(hooksTomlPath, 'utf8') : '';
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

// An existing file the parser cannot read is never edited: the text edit
// would be exact for the EGC blocks, but the person has a broken file to
// fix first and a write would hide that.
function assertEditable(hooksTomlPath, original) {
  if (original !== '' && !parsesAsToml(original)) {
    throw new TypeError(`existing file at ${hooksTomlPath} is not valid TOML - left untouched`);
  }
}

function writeHooksFile(hooksTomlPath, updated) {
  if (!parsesAsToml(updated)) {
    throw new TypeError(`existing file at ${hooksTomlPath} could not be updated without breaking it - left untouched`);
  }
  fs.mkdirSync(path.dirname(hooksTomlPath), { recursive: true });
  fs.writeFileSync(hooksTomlPath, updated, 'utf8');
}

/**
 * Writes the EGC hook of a script into hooks.toml, replacing an older block
 * of the same name.
 * @param {string} hooksTomlPath
 * @param {string} hookScriptPath
 * @param {string} matcher
 * @returns {{changed: boolean}}
 */
function applyVibeHookToFile(hooksTomlPath, hookScriptPath, matcher) {
  const name = hookNameOfScript(hookScriptPath);
  if (!name) throw new TypeError(`not an EGC hook script for Vibe: ${hookScriptPath}`);
  const original = readHooksFile(hooksTomlPath);
  assertEditable(hooksTomlPath, original);
  const rendered = renderHookBlock(name, buildHookCommand(hookScriptPath), matcher);
  const { content, changed } = upsertHookBlock(original, name, rendered);
  if (changed) writeHooksFile(hooksTomlPath, content);
  return { changed };
}

/**
 * Removes the EGC hook of a script from hooks.toml, leaving every other
 * block as it was.
 * @param {string} hooksTomlPath
 * @param {string} hookScriptPath
 * @returns {{changed: boolean}}
 */
function removeVibeHookFromFile(hooksTomlPath, hookScriptPath) {
  const name = hookNameOfScript(hookScriptPath);
  if (!name || !fs.existsSync(hooksTomlPath)) return { changed: false };
  const original = readHooksFile(hooksTomlPath);
  assertEditable(hooksTomlPath, original);
  const { content, changed } = removeHookBlocks(original, name);
  if (changed) writeHooksFile(hooksTomlPath, content);
  return { changed };
}

/**
 * Whether hooks.toml holds the EGC hook of a script exactly as an install
 * writes it. With the matcher the whole block is compared, so a strict flag
 * flipped to false or a type changed by hand is drift the doctor reports
 * and repair rewrites; without it (a retirement check) the name and the
 * command decide.
 * @param {string} hooksTomlPath
 * @param {string} hookScriptPath
 * @param {string} [matcher]
 * @returns {'ok'|'drifted'}
 */
function inspectVibeHookFile(hooksTomlPath, hookScriptPath, matcher) {
  try {
    const name = hookNameOfScript(hookScriptPath);
    const command = buildHookCommand(hookScriptPath);
    const { lines, blocks } = parseHookBlocks(readHooksFile(hooksTomlPath));
    const found = blocks.some(block => (
      block.name === name
      && block.command === command
      && (matcher === undefined || lines.slice(block.start, block.end + 1).join('\n') === renderHookBlock(name, command, matcher))
    ));
    return found ? 'ok' : 'drifted';
  } catch {
    return 'drifted';
  }
}

// The handlers claude-settings-hooks.js dispatches a vibe:pre_tool
// operation to.
const VIBE_HOOK_OPERATION_HANDLERS = Object.freeze({
  apply: operation => applyVibeHookToFile(operation.destinationPath, operation.hookScriptPath, operation.hookMatcher),
  remove: operation => removeVibeHookFromFile(operation.destinationPath, operation.hookScriptPath),
  inspect: operation => inspectVibeHookFile(operation.destinationPath, operation.hookScriptPath, operation.hookMatcher),
});

function createVibeHookMergeOperation(targetRoot, { moduleId, sourceRelativePath, matcher, hookScriptPath }) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId,
    sourceRelativePath,
    destinationPath: resolveVibeHooksTomlPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: VIBE_PRE_TOOL_EVENT,
    hookMatcher: matcher,
    hookScriptPath,
  };
}

/**
 * The Guardian pre_tool entry of hooks.toml under targetRoot.
 * @param {string} targetRoot
 * @returns {object}
 */
function createVibeGuardianHookMergeOperation(targetRoot) {
  return createVibeHookMergeOperation(targetRoot, {
    moduleId: BASH_GUARDIAN_HOOK_MODULE_ID,
    sourceRelativePath: GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    matcher: VIBE_GUARDIAN_MATCHER,
    hookScriptPath: resolveVibeGuardianAdapterDestination(targetRoot),
  });
}

/**
 * The Token Crusher pre_tool entry of hooks.toml under targetRoot.
 * @param {string} targetRoot
 * @returns {object}
 */
function createVibeCrusherHookMergeOperation(targetRoot) {
  return createVibeHookMergeOperation(targetRoot, {
    moduleId: CRUSHER_HOOK_MODULE_ID,
    sourceRelativePath: CRUSHER_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    matcher: VIBE_CRUSHER_MATCHER,
    hookScriptPath: resolveVibeCrusherAdapterDestination(targetRoot),
  });
}

/**
 * The copies the Guardian adapter needs next to it under targetRoot: the
 * Bash and write validators, the stdin reader and the adapter itself.
 * @param {Function} createRemappedOperation
 * @param {string} targetRoot
 * @returns {Array<object>}
 */
function createVibeGuardianScriptCopyOperations(createRemappedOperation, targetRoot) {
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
      resolveVibeGuardianAdapterDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
  ];
}

/**
 * The copy of the Crusher adapter under targetRoot; the rewrite decision it
 * loads comes with createCrusherScriptCopyOperations.
 * @param {Function} createRemappedOperation
 * @param {string} targetRoot
 * @returns {object}
 */
function createVibeCrusherAdapterCopyOperation(createRemappedOperation, targetRoot) {
  return createRemappedOperation(
    CRUSHER_HOOK_MODULE_ID,
    CRUSHER_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    resolveVibeCrusherAdapterDestination(targetRoot),
    { strategy: 'preserve-relative-path' }
  );
}

module.exports = {
  VIBE_CRUSHER_HOOK_NAME,
  VIBE_CRUSHER_MATCHER,
  VIBE_GUARDIAN_HOOK_NAME,
  VIBE_GUARDIAN_MATCHER,
  VIBE_HOOKS_FILE_NAME,
  VIBE_HOOK_OPERATION_HANDLERS,
  VIBE_PRE_TOOL_EVENT,
  applyVibeHookToFile,
  createVibeCrusherAdapterCopyOperation,
  createVibeCrusherHookMergeOperation,
  createVibeGuardianHookMergeOperation,
  createVibeGuardianScriptCopyOperations,
  inspectVibeHookFile,
  parseHookBlocks,
  removeVibeHookFromFile,
  renderHookBlock,
  resolveVibeCrusherAdapterDestination,
  resolveVibeGuardianAdapterDestination,
  resolveVibeHooksTomlPath,
};
