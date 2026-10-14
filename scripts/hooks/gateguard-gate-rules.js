'use strict';

const path = require('node:path');

function sanitizePath(filePath) {
  // Strip control chars (including null), bidi overrides, and newlines
  let sanitized = '';
  for (const char of String(filePath || '')) {
    const code = char.codePointAt(0);
    const isAsciiControl = code <= 0x1f || code === 0x7f;
    const isBidiOverride = (code >= 0x200e && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    sanitized += isAsciiControl || isBidiOverride ? ' ' : char;
  }
  return sanitized.trim().slice(0, 500);
}

function normalizeForMatch(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .toLowerCase();
}

// The settings file of the harness the gate runs under, Claude Code's or
// the retired Gemini CLI's (`.claude/settings.json`,
// `.gemini/settings.local.json`, ...): an edit there is how the hook itself
// is configured or disabled, so it is never gated. Antigravity's own hooks
// files (`.gemini/config/hooks.json`, `.agents/hooks.json`), where the gate
// runs as the egc-gateguard named hook, are exempt the same way: the
// Guardian denies the agent those surfaces outright, so a gate retry there
// would only cost a turn. They are matched the way the filesystem does, so
// on a case-sensitive one `.AGENTS/hooks.json`, a file the Guardian does
// not protect, stays gated. Nothing else under those directories is exempt.
const CASE_INSENSITIVE_FILESYSTEM = process.platform === 'win32' || process.platform === 'darwin';
const ANTIGRAVITY_HOOKS_FILE_RE = /(^|\/)\.(?:gemini\/config|agents)\/hooks\.json$/;

function isAntigravityHooksPath(filePath) {
  const slashed = String(filePath || '').replaceAll('\\', '/');
  return ANTIGRAVITY_HOOKS_FILE_RE.test(CASE_INSENSITIVE_FILESYSTEM ? slashed.toLowerCase() : slashed);
}

function isGateExemptPath(filePath) {
  const normalized = normalizeForMatch(filePath);
  return /(^|\/)\.(?:claude|gemini)\/settings(?:\.[^/]+)?\.json$/.test(normalized) || isAntigravityHooksPath(filePath);
}

// A document has readers, not importers. Asking a note or a piece of
// documentation which files require it, and which public functions it
// exports, spends a round on questions that have no answer and teaches
// whoever reads the gate that it is not paying attention.
const PROSE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc', '.org']);

function isProseFile(filePath) {
  return PROSE_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function gateMsg(action, filePath, questions) {
  return [
    '[Fact-Forcing Gate]',
    '',
    `Before ${action} ${sanitizePath(filePath)}, present these facts:`,
    '',
    ...questions,
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function editGateMsg(filePath) {
  if (isProseFile(filePath)) {
    return gateMsg('editing', filePath, [
      '1. Say what this document is for and who reads it',
      '2. Say what changes in it and why it changes now',
      "3. Quote the user's current instruction verbatim"
    ]);
  }
  const safe = sanitizePath(filePath);
  return [
    '[Fact-Forcing Gate]',
    '',
    `Before editing ${safe}, present these facts:`,
    '',
    '1. List ALL files that import/require this file (use Grep)',
    '2. List the public functions/classes affected by this change',
    '3. If this file reads/writes data files, show field names, structure, and date format (use redacted or synthetic values, not raw production data)',
    "4. Quote the user's current instruction verbatim",
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function writeGateMsg(filePath) {
  if (isProseFile(filePath)) {
    return gateMsg('creating', filePath, [
      '1. Say what this document is for and who reads it',
      '2. Confirm no existing document already covers it (use Glob)',
      '3. Say where it will be linked from, or that it stands on its own',
      "4. Quote the user's current instruction verbatim"
    ]);
  }
  const safe = sanitizePath(filePath);
  return [
    '[Fact-Forcing Gate]',
    '',
    `Before creating ${safe}, present these facts:`,
    '',
    '1. Name the file(s) and line(s) that will call this new file',
    '2. Confirm no existing file serves the same purpose (use Glob)',
    '3. If this file reads/writes data files, show field names, structure, and date format (use redacted or synthetic values, not raw production data)',
    "4. Quote the user's current instruction verbatim",
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function destructiveBashMsg() {
  return [
    '[Fact-Forcing Gate]',
    '',
    'Destructive command detected. Before running, present:',
    '',
    '1. List all files/data this command will modify or delete',
    '2. Write a one-line rollback procedure',
    "3. Quote the user's current instruction verbatim",
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

function routineBashMsg() {
  return [
    '[Fact-Forcing Gate]',
    '',
    'Before the first Bash command this session, present these facts:',
    '',
    '1. The current user request in one sentence',
    '2. What this specific command verifies or produces',
    '',
    'Present the facts, then retry the same operation.'
  ].join('\n');
}

const EDIT_WRITE_HOOK_ID = 'pre:edit-write:gateguard-fact-force';
const BASH_HOOK_ID = 'pre:bash:gateguard-fact-force';

function withRecoveryHint(message, hookIds = [EDIT_WRITE_HOOK_ID]) {
  const disableTargets = hookIds.map(hookId => `\`${hookId}\``).join(' or ');
  return [
    message,
    '',
    `Recovery: a human doing setup or repair work can lift this gate by adding ${disableTargets} to \`EGC_DISABLED_HOOKS\`.`
  ].join('\n');
}

function denyResult(reason, options = {}) {
  const includeRecoveryHint = options.includeRecoveryHint !== false;
  const hookIds = Array.isArray(options.hookIds) && options.hookIds.length > 0 ? options.hookIds : [EDIT_WRITE_HOOK_ID];
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: includeRecoveryHint ? withRecoveryHint(reason, hookIds) : reason
      }
    }),
    exitCode: 0
  };
}

function allowWithStateWarning() {
  return {
    stderr: '[Fact-Forcing Gate] GateGuard state could not be persisted; allowing this operation to avoid a permanent retry loop. Check GATEGUARD_STATE_DIR or filesystem permissions.',
    exitCode: 0
  };
}

// The path-exemption, message-template and deny-helper slice of the
// gateguard-fact-force.js split (part of #1712): what the gate says and
// which paths it never gates, moved as is.
module.exports = {
  EDIT_WRITE_HOOK_ID,
  BASH_HOOK_ID,
  sanitizePath,
  isGateExemptPath,
  editGateMsg,
  writeGateMsg,
  destructiveBashMsg,
  routineBashMsg,
  denyResult,
  allowWithStateWarning,
};
