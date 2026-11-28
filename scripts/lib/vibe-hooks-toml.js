'use strict';

// Manages the EGC entries of Mistral Vibe's hooks.toml: the Guardian and
// the Token Crusher on pre_tool, the session start on session_start and the
// Team Brain push on post_agent. Vibe declares hooks as [[hooks]] tables
// (name, type, match, command, timeout, strict, description), loads
// <project>/.vibe/hooks.toml before ~/.vibe/hooks.toml, and a hook of the
// same name in both files resolves to the project entry, so the two scopes
// never run a hook twice.
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
const VIBE_SESSION_START_EVENT = 'vibe:session_start';
const VIBE_POST_AGENT_EVENT = 'vibe:post_agent';
const VIBE_HOOKS_FILE_NAME = 'hooks.toml';
const VIBE_GUARDIAN_HOOK_NAME = 'egc-guardian';
const VIBE_CRUSHER_HOOK_NAME = 'egc-crusher';
const VIBE_SESSION_START_HOOK_NAME = 'egc-session-start';
const VIBE_STOP_HOOK_NAME = 'egc-stop';
const VIBE_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/vibe-session-start.js';
const TEAM_SYNC_STOP_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/team-sync-stop.js';
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
const SHELL_EDIT_ADAPTER_SOURCE_RELATIVE_PATH = 'scripts/lib/shell-edit-guardian-adapter.js';
const CRUSHER_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/vibe-crusher-adapter.js';
const GUARDIAN_ADAPTER_BASENAME = path.basename(GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);
const CRUSHER_ADAPTER_BASENAME = path.basename(CRUSHER_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);

// The EGC hooks by name, each with the event type it goes under. The
// Guardian is strict: a failure of the adapter itself denies the call
// instead of letting it through. The Crusher is not: a failure runs the
// original command. The session hooks are not either: a restore or a push
// that could not run never stops the session, and neither takes a matcher.
// session_start reads hook_specific_output.additional_context back and puts
// it before the first message; post_agent runs after each response, where
// Claude Code's Stop runs, and reads nothing from the push.
const EGC_HOOKS = Object.freeze({
  [VIBE_GUARDIAN_HOOK_NAME]: Object.freeze({
    type: 'pre_tool',
    strict: true,
    description: 'EGC Guardian: validates every shell command and file edit before it runs.',
  }),
  [VIBE_CRUSHER_HOOK_NAME]: Object.freeze({
    type: 'pre_tool',
    strict: false,
    description: 'EGC Token Crusher: routes a noisy shell command through egc run.',
  }),
  [VIBE_SESSION_START_HOOK_NAME]: Object.freeze({
    type: 'session_start',
    strict: false,
    description: 'EGC: restores the project memory and pulls the Team Brain when a session starts.',
  }),
  [VIBE_STOP_HOOK_NAME]: Object.freeze({
    type: 'post_agent',
    strict: false,
    description: 'EGC: pushes the Team Brain after a response that changed the state.',
  }),
});
// The EGC hook each script stands for, by its file name.
const HOOK_NAME_BY_BASENAME = Object.freeze({
  [GUARDIAN_ADAPTER_BASENAME]: VIBE_GUARDIAN_HOOK_NAME,
  [CRUSHER_ADAPTER_BASENAME]: VIBE_CRUSHER_HOOK_NAME,
  [path.basename(VIBE_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH)]: VIBE_SESSION_START_HOOK_NAME,
  [path.basename(TEAM_SYNC_STOP_SCRIPT_SOURCE_RELATIVE_PATH)]: VIBE_STOP_HOOK_NAME,
});

const HOOKS_TABLE_HEADER_RE = /^\s*\[\[\s*hooks\s*\]\]\s*(?:#.*)?$/;
const ANY_TABLE_HEADER_RE = /^\s*\[/;
const NAME_LINE_RE = /^\s*name\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/;
const COMMAND_LINE_RE = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/;
const MATCH_LINE_RE = /^\s*match\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/;

// TOML basic strings: a backslash, a quote and every control character are
// escaped, so a path with a newline or a tab still gives a file Vibe parses.
const TOML_ESCAPES = Object.freeze({ '\b': String.raw`\b`, '\t': String.raw`\t`, '\n': String.raw`\n`, '\f': String.raw`\f`, '\r': String.raw`\r` });
const TOML_UNESCAPES = Object.freeze({ b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' });

function tomlCharacter(character) {
  if (character === '\\') return '\\\\';
  if (character === '"') return String.raw`\"`;
  const code = character.codePointAt(0);
  if (code >= 0x20 && code !== 0x7f) return character;
  return TOML_ESCAPES[character] || (String.raw`\u` + code.toString(16).padStart(4, '0'));
}

function tomlString(value) {
  return '"' + Array.from(String(value), tomlCharacter).join('') + '"';
}

function tomlUnescape(value) {
  return value.replace(/\\(u[0-9a-fA-F]{4}|[btnfr"\\])/g, (_match, code) => (
    code.startsWith('u') ? String.fromCodePoint(Number.parseInt(code.slice(1), 16)) : TOML_UNESCAPES[code]
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

// The EGC hook a script path stands for, by the script's file name: the
// install state keeps the script path of every hook entry, not its name.
function hookNameOfScript(hookScriptPath) {
  return HOOK_NAME_BY_BASENAME[path.basename(String(hookScriptPath))] || null;
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

// The block of one EGC hook: a tool hook carries its match, a session hook
// none.
function renderHookBlock(name, command, matcher) {
  const hook = EGC_HOOKS[name];
  return [
    '[[hooks]]',
    `name = ${tomlString(name)}`,
    `type = ${tomlString(hook.type)}`,
    ...(matcher === undefined ? [] : [`match = ${tomlString(matcher)}`]),
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
 * writes it. An exact check compares the whole block, so a strict flag
 * flipped to false or a type changed by hand is drift the doctor reports
 * and repair rewrites; the check is exact when a matcher is given or when
 * asked for, and otherwise (a retirement check) the name and the command
 * decide.
 * @param {string} hooksTomlPath
 * @param {string} hookScriptPath
 * @param {string} [matcher]
 * @param {boolean} [exact]
 * @returns {'ok'|'drifted'}
 */
function inspectVibeHookFile(hooksTomlPath, hookScriptPath, matcher, exact = matcher !== undefined) {
  try {
    const name = hookNameOfScript(hookScriptPath);
    const command = buildHookCommand(hookScriptPath);
    const { lines, blocks } = parseHookBlocks(readHooksFile(hooksTomlPath));
    const found = blocks.some(block => (
      block.name === name
      && block.command === command
      && (!exact || lines.slice(block.start, block.end + 1).join('\n') === renderHookBlock(name, command, matcher))
    ));
    return found ? 'ok' : 'drifted';
  } catch {
    return 'drifted';
  }
}

// The handlers claude-settings-hooks.js dispatches a vibe:pre_tool,
// vibe:session_start or vibe:post_agent operation to: the name of the hook
// comes from the script, so the event only routes here.
const VIBE_HOOK_OPERATION_HANDLERS = Object.freeze({
  apply: operation => applyVibeHookToFile(operation.destinationPath, operation.hookScriptPath, operation.hookMatcher),
  remove: operation => removeVibeHookFromFile(operation.destinationPath, operation.hookScriptPath),
  inspect: operation => inspectVibeHookFile(operation.destinationPath, operation.hookScriptPath, operation.hookMatcher, true),
});

function createVibeHookMergeOperation(targetRoot, { moduleId, sourceRelativePath, matcher, hookScriptPath, hookEvent = VIBE_PRE_TOOL_EVENT }) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId,
    sourceRelativePath,
    destinationPath: resolveVibeHooksTomlPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent,
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
 * The two session entries of hooks.toml under targetRoot: session_start
 * runs the Vibe wrapper of the shared host session start (the pull and the
 * restore, answered as hook_specific_output.additional_context), post_agent
 * runs the shared Team Brain push. Neither takes a matcher.
 * @param {string} targetRoot
 * @returns {Array<object>}
 */
function createVibeSessionHookMergeOperations(targetRoot) {
  const { HOST_SESSION_HOOK_MODULE_ID, resolveTeamSyncStopHookScriptDestination } = require('./claude-settings-hook-copy-operations');
  return [
    createVibeHookMergeOperation(targetRoot, {
      moduleId: HOST_SESSION_HOOK_MODULE_ID,
      sourceRelativePath: VIBE_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH,
      hookEvent: VIBE_SESSION_START_EVENT,
      hookScriptPath: path.join(targetRoot, ...VIBE_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH.split('/')),
    }),
    createVibeHookMergeOperation(targetRoot, {
      moduleId: HOST_SESSION_HOOK_MODULE_ID,
      sourceRelativePath: TEAM_SYNC_STOP_SCRIPT_SOURCE_RELATIVE_PATH,
      hookEvent: VIBE_POST_AGENT_EVENT,
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
      SHELL_EDIT_ADAPTER_SOURCE_RELATIVE_PATH,
      path.join(targetRoot, ...SHELL_EDIT_ADAPTER_SOURCE_RELATIVE_PATH.split('/')),
      { strategy: 'preserve-relative-path' }
    ),
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
  VIBE_POST_AGENT_EVENT,
  VIBE_PRE_TOOL_EVENT,
  VIBE_SESSION_START_EVENT,
  VIBE_SESSION_START_HOOK_NAME,
  VIBE_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH,
  VIBE_STOP_HOOK_NAME,
  applyVibeHookToFile,
  createVibeCrusherAdapterCopyOperation,
  createVibeCrusherHookMergeOperation,
  createVibeGuardianHookMergeOperation,
  createVibeGuardianScriptCopyOperations,
  createVibeSessionHookMergeOperations,
  inspectVibeHookFile,
  parseHookBlocks,
  removeVibeHookFromFile,
  renderHookBlock,
  resolveVibeCrusherAdapterDestination,
  resolveVibeGuardianAdapterDestination,
  resolveVibeHooksTomlPath,
  tomlString,
  tomlUnescape,
};
