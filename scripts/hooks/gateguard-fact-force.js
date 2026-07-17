#!/usr/bin/env node
/**
 * PreToolUse Hook: GateGuard Fact-Forcing Gate
 *
 * Forces Gemini to investigate before editing files or running commands.
 * Instead of asking "are you sure?" (which LLMs always answer "yes"),
 * this hook demands concrete facts: importers, public API, data schemas.
 *
 * The act of investigation creates awareness that self-evaluation never did.
 *
 * Gates:
 *   - Edit/Write: list importers, affected API, verify data schemas, quote instruction
 *   - apply_patch (Codex CLI's freeform file-edit tool): same gate as Edit,
 *     applied to every file path parsed out of the patch text
 *   - Bash (destructive): list targets, rollback plan, quote instruction
 *   - Bash (routine): quote current instruction (once per session)
 *
 * Compatible with run-with-flags.js via module.exports.run().
 * Cross-platform (Windows, macOS, Linux).
 *
 * Full package with config support: pip install gateguard-ai
 * Repo: https://github.com/zunoworks/gateguard
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Session state: scoped per session to avoid cross-session races.
const STATE_DIR = process.env.GATEGUARD_STATE_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.gateguard');
let activeStateFile = null;

// State expires after 30 minutes of inactivity
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const READ_HEARTBEAT_MS = 60 * 1000;

// Maximum checked entries to prevent unbounded growth
const MAX_CHECKED_ENTRIES = 500;
const MAX_SESSION_KEYS = 50;
const ROUTINE_BASH_SESSION_KEY = '__bash_session__';
const EDIT_WRITE_HOOK_ID = 'pre:edit-write:gateguard-fact-force';
const BASH_HOOK_ID = 'pre:bash:gateguard-fact-force';
const EGC_DISABLE_VALUES = new Set(['0', 'false', 'off', 'disabled', 'disable']);

const DESTRUCTIVE_BASH = /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+checkout\s+--|git\s+clean\s+-f|drop\s+table|delete\s+from|truncate|git\s+push\s+--force(?!-with-lease)|git\s+commit\s+--amend|dd\s+if=)\b/i;

// --- State management (per-session, atomic writes, bounded) ---

function normalizeEnvValue(value) {
  return String(value || '').trim().toLowerCase();
}

function isGateGuardDisabled() {
  if (normalizeEnvValue(process.env.GATEGUARD_DISABLED) === '1') {
    return true;
  }

  return EGC_DISABLE_VALUES.has(normalizeEnvValue(process.env.EGC_GATEGUARD || process.env.ECC_GATEGUARD));
}

function sanitizeSessionKey(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (sanitized && sanitized.length <= 64) {
    return sanitized;
  }

  return hashSessionKey('sid', raw);
}

function hashSessionKey(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;
}

function resolveSessionKey(data) {
  const directCandidates = [data?.session_id, data?.sessionId, data?.session?.id, process.env.EGC_SESSION_ID, process.env.ECC_SESSION_ID];

  for (const candidate of directCandidates) {
    const sanitized = sanitizeSessionKey(candidate);
    if (sanitized) {
      return sanitized;
    }
  }

  const transcriptPath = (data && (data.transcript_path || data.transcriptPath)) || process.env.GEMINI_TRANSCRIPT_PATH;
  if (transcriptPath && String(transcriptPath).trim()) {
    return hashSessionKey('tx', path.resolve(String(transcriptPath).trim()));
  }

  const projectFingerprint = process.env.GEMINI_PROJECT_DIR || process.cwd();
  return hashSessionKey('proj', path.resolve(projectFingerprint));
}

function getStateFile(data) {
  if (!activeStateFile) {
    const sessionKey = resolveSessionKey(data);
    activeStateFile = path.join(STATE_DIR, `state-${sessionKey}.json`);
  }
  return activeStateFile;
}

function loadState() {
  const stateFile = getStateFile();
  try {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const lastActive = state.last_active || 0;
      if (Date.now() - lastActive > SESSION_TIMEOUT_MS) {
        try {
          fs.unlinkSync(stateFile);
        } catch (_) {
          /* ignore */
        }
        return { checked: [], last_active: Date.now() };
      }
      return state;
    }
  } catch (_) {
    /* ignore */
  }
  return { checked: [], last_active: Date.now() };
}

function pruneCheckedEntries(checked) {
  if (checked.length <= MAX_CHECKED_ENTRIES) {
    return checked;
  }

  const preserved = checked.includes(ROUTINE_BASH_SESSION_KEY) ? [ROUTINE_BASH_SESSION_KEY] : [];
  const sessionKeys = checked.filter(k => k.startsWith('__') && k !== ROUTINE_BASH_SESSION_KEY);
  const fileKeys = checked.filter(k => !k.startsWith('__'));
  const remainingSessionSlots = Math.max(MAX_SESSION_KEYS - preserved.length, 0);
  const cappedSession = sessionKeys.slice(-remainingSessionSlots);
  const remainingFileSlots = Math.max(MAX_CHECKED_ENTRIES - preserved.length - cappedSession.length, 0);
  const cappedFiles = fileKeys.slice(-remainingFileSlots);
  return [...preserved, ...cappedSession, ...cappedFiles];
}

function mergeStateWithDisk(stateFile, checked, lastActive) {
  try {
    if (!fs.existsSync(stateFile)) return { checked, lastActive };
    const diskState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return {
      checked: Array.isArray(diskState.checked) ? Array.from(new Set([...diskState.checked, ...checked])) : checked,
      lastActive: typeof diskState.last_active === 'number' ? Math.max(lastActive, diskState.last_active) : lastActive,
    };
  } catch (_) {
    return { checked, lastActive };
  }
}

function atomicRenameFile(tmpFile, stateFile) {
  try {
    fs.renameSync(tmpFile, stateFile);
  } catch (error) {
    if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
      try { fs.unlinkSync(stateFile); } catch (_) { /* ignore: best-effort unlink before retry, subsequent renameSync will handle failures */ }
      fs.renameSync(tmpFile, stateFile);
    } else {
      throw error;
    }
  }
}

function saveState(state) {
  const stateFile = getStateFile();
  let tmpFile = null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });

    const rawChecked = Array.isArray(state.checked) ? state.checked : [];
    const rawLastActive = typeof state.last_active === 'number' ? state.last_active : 0;
    const merged = mergeStateWithDisk(stateFile, rawChecked, rawLastActive);

    const finalState = {
      checked: pruneCheckedEntries(merged.checked),
      last_active: Math.max(merged.lastActive, Date.now()),
    };

    // Atomic write: temp file + rename prevents partial reads
    tmpFile = `${stateFile}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmpFile, JSON.stringify(finalState, null, 2), 'utf8');
    atomicRenameFile(tmpFile, stateFile);
    tmpFile = null;
    return true;
  } catch (_) {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_2) { /* ignore: best-effort cleanup of temporary state file during save failure */ } }
    return false;
  }
}

function markChecked(key) {
  const state = loadState();
  if (!state.checked.includes(key)) {
    state.checked.push(key);
    return saveState(state);
  }
  return true;
}

function isChecked(key) {
  const state = loadState();
  const found = state.checked.includes(key);
  if (found && Date.now() - (state.last_active || 0) > READ_HEARTBEAT_MS) {
    saveState(state);
  }
  return found;
}

// Prune stale session files older than 1 hour
(function pruneStaleFiles() {
  try {
    const files = fs.readdirSync(STATE_DIR);
    const now = Date.now();
    for (const f of files) {
      const isStateFile = f.startsWith('state-') && (f.endsWith('.json') || f.includes('.json.tmp.'));
      if (!isStateFile) continue;
      const fp = path.join(STATE_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > SESSION_TIMEOUT_MS * 2) {
          fs.unlinkSync(fp);
        }
      } catch (_) {
        // Ignore files that disappear between readdir/stat/unlink.
      }
    }
  } catch (_) {
    /* ignore */
  }
})();

// --- Sanitize file path against injection ---

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
    .replace(/\\/g, '/')
    .toLowerCase();
}

function isClaudeSettingsPath(filePath) {
  const normalized = normalizeForMatch(filePath);
  return /(^|\/)\.gemini\/settings(?:\.[^/]+)?\.json$/.test(normalized);
}

const SAFE_GIT_SUBCOMMANDS = {
  status: (args) => args.every(arg => ['--porcelain', '--short', '--branch'].includes(arg)),
  diff: (args) => args.length <= 1 && args.every(arg => ['--name-only', '--name-status'].includes(arg)),
  log: (args) => args.every(arg => arg === '--oneline' || /^--max-count=\d+$/.test(arg)),
  show: (args) => args.length === 1 && !args[0].startsWith('--') && /^[a-zA-Z0-9._:/-]+$/.test(args[0]),
  branch: (args) => args.length === 1 && args[0] === '--show-current',
  'rev-parse': (args) => args.length === 2 && args[0] === '--abbrev-ref' && /^head$/i.test(args[1]),
};

function isReadOnlyGitIntrospection(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed || /[\r\n;&|><`$()]/.test(trimmed)) return false;

  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== 'git' || tokens.length < 2) return false;

  const checker = SAFE_GIT_SUBCOMMANDS[tokens[1].toLowerCase()];
  return checker ? checker(tokens.slice(2)) : false;
}

// --- Gate messages ---

function editGateMsg(filePath) {
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

function withRecoveryHint(message, hookIds = [EDIT_WRITE_HOOK_ID]) {
  const disableTargets = hookIds.map(hookId => `\`${hookId}\``).join(' or ');
  return [
    message,
    '',
    `Recovery: if GateGuard is blocking setup or repair work, run this session with \`EGC_GATEGUARD=off\` or add ${disableTargets} to \`EGC_DISABLED_HOOKS\`.`
  ].join('\n');
}

// --- Deny helper ---

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

const { trace } = require('../lib/utils');

// --- Per-tool gate handlers ---

/**
 * Handle the Edit or Write tool gate.
 *
 * @param {string} rawInput
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {*}
 */
function handleEditWrite(rawInput, toolName, toolInput) {
  const filePath = toolInput.file_path || '';
  if (!filePath || isClaudeSettingsPath(filePath)) {
    trace('governance:allowed:settings', { toolName, filePath });
    return rawInput;
  }

  if (!isChecked(filePath)) {
    if (!markChecked(filePath)) {
      trace('governance:allowed:state_error', { toolName, filePath });
      return allowWithStateWarning();
    }
    trace('governance:denied:fact_force', { toolName, filePath });
    return denyResult(toolName === 'Edit' ? editGateMsg(filePath) : writeGateMsg(filePath));
  }

  trace('governance:allowed:checked', { toolName, filePath });
  return rawInput;
}

/**
 * Handle the MultiEdit tool gate.
 *
 * @param {string} rawInput
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {*}
 */
function handleMultiEdit(rawInput, toolName, toolInput) {
  const edits = toolInput.edits || [];
  for (const edit of edits) {
    const filePath = edit.file_path || '';
    if (filePath && !isClaudeSettingsPath(filePath) && !isChecked(filePath)) {
      if (!markChecked(filePath)) {
        trace('governance:allowed:state_error', { toolName, filePath });
        return allowWithStateWarning();
      }
      trace('governance:denied:fact_force', { toolName, filePath });
      return denyResult(editGateMsg(filePath));
    }
  }
  trace('governance:allowed:multiedit');
  return rawInput;
}

/**
 * Extract file paths touched by a Codex `apply_patch` freeform patch.
 *
 * Codex's apply_patch tool is a single freeform-text argument (a patch in
 * `*** Begin Patch` / `*** Update File: <path>` / `*** End Patch` format),
 * not a JSON object with a file_path field like Claude's Edit/Write. Parse
 * the patch header lines to recover the path(s) it touches so the same
 * fact-forcing gate can apply per file.
 *
 * @param {string} patchText
 * @returns {string[]}
 */
function extractApplyPatchFilePaths(patchText) {
  const text = String(patchText || '');
  const pattern = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  const paths = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1]) {
      paths.push(match[1].trim());
    }
  }
  return paths;
}

/**
 * Handle the Codex `apply_patch` tool gate (freeform patch text, may touch
 * multiple files in one call, so this mirrors handleMultiEdit's loop).
 *
 * @param {string} rawInput
 * @param {*} rawPatchInput
 * @returns {*}
 */
function handleApplyPatch(rawInput, rawPatchInput) {
  const patchText = typeof rawPatchInput === 'string' ? rawPatchInput : '';
  const filePaths = extractApplyPatchFilePaths(patchText);
  if (filePaths.length === 0) {
    trace('governance:allowed:apply_patch_unparsed');
    return rawInput;
  }

  for (const filePath of filePaths) {
    if (isClaudeSettingsPath(filePath) || isChecked(filePath)) {
      continue;
    }
    if (!markChecked(filePath)) {
      trace('governance:allowed:state_error', { toolName: 'apply_patch', filePath });
      return allowWithStateWarning();
    }
    trace('governance:denied:fact_force', { toolName: 'apply_patch', filePath });
    return denyResult(editGateMsg(filePath));
  }

  trace('governance:allowed:apply_patch');
  return rawInput;
}

/**
 * Handle the Bash tool gate.
 *
 * @param {string} rawInput
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {*}
 */
function handleBash(rawInput, toolName, toolInput) {
  const command = toolInput.command || '';
  if (isReadOnlyGitIntrospection(command)) {
    trace('governance:allowed:git_intro', { command });
    return rawInput;
  }

  if (DESTRUCTIVE_BASH.test(command)) {
    const key = '__destructive__' + crypto.createHash('sha256').update(command).digest('hex').slice(0, 16);
    if (!isChecked(key)) {
      if (!markChecked(key)) {
        trace('governance:allowed:state_error', { toolName, command });
        return allowWithStateWarning();
      }
      trace('governance:denied:destructive', { command });
      return denyResult(destructiveBashMsg(), { includeRecoveryHint: false });
    }
    trace('governance:allowed:destructive_retry', { command });
    return rawInput;
  }

  if (!isChecked(ROUTINE_BASH_SESSION_KEY)) {
    if (!markChecked(ROUTINE_BASH_SESSION_KEY)) {
      trace('governance:allowed:state_error', { toolName, command });
      return allowWithStateWarning();
    }
    trace('governance:denied:routine_bash', { command });
    return denyResult(routineBashMsg(), { hookIds: [BASH_HOOK_ID] });
  }

  trace('governance:allowed:bash', { command });
  return rawInput;
}

// --- Core logic (exported for run-with-flags.js) ---

function run(rawInput) {
  let data;
  try {
    data = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch (_) {
    return rawInput; // allow on parse error
  }

  if (isGateGuardDisabled()) {
    trace('governance:disabled');
    return rawInput;
  }

  activeStateFile = null;
  getStateFile(data);

  const rawToolName = data.tool_name || '';
  const toolInput = data.tool_input || {};
  // Normalize: case-insensitive matching via lookup map.
  // apply_patch is Codex CLI's canonical tool name for file edits (its
  // freeform patch tool); Edit/Write/MultiEdit are only matcher aliases on
  // the Codex side, the payload's tool_name stays "apply_patch".
  const TOOL_MAP = { edit: 'Edit', write: 'Write', multiedit: 'MultiEdit', bash: 'Bash', apply_patch: 'ApplyPatch' };
  const toolName = TOOL_MAP[rawToolName.toLowerCase()] || rawToolName;

  if (toolName === 'Edit' || toolName === 'Write') {
    return handleEditWrite(rawInput, toolName, toolInput);
  }

  if (toolName === 'MultiEdit') {
    return handleMultiEdit(rawInput, toolName, toolInput);
  }

  if (toolName === 'ApplyPatch') {
    return handleApplyPatch(rawInput, data.tool_input);
  }

  if (toolName === 'Bash') {
    return handleBash(rawInput, toolName, toolInput);
  }

  return rawInput; // allow
}

module.exports = { run };

// --- Direct CLI entrypoint ---
//
// Claude Code invokes PreToolUse hook scripts directly (`node <script>.js`
// with the tool-call JSON on stdin), unlike Gemini's run-with-flags.js or
// bash-hook-dispatcher.js, which both require() and call run() in-process.
// This block only executes when the file is run as a standalone process, so
// it does not change behavior for either of those existing callers.
if (require.main === module) {
  const MAX_STDIN = 1024 * 1024;
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      raw += chunk.substring(0, MAX_STDIN - raw.length);
    }
  });
  process.stdin.on('end', () => {
    const output = run(raw);

    if (typeof output === 'string' || Buffer.isBuffer(output)) {
      process.stdout.write(String(output));
      process.exit(0);
    }

    if (output && typeof output === 'object') {
      if (typeof output.stderr === 'string' && output.stderr) {
        process.stderr.write(output.stderr.endsWith('\n') ? output.stderr : `${output.stderr}\n`);
      }

      if (Object.hasOwn(output, 'stdout')) {
        process.stdout.write(String(output.stdout ?? ''));
      } else if (!Number.isInteger(output.exitCode) || output.exitCode === 0) {
        process.stdout.write(raw);
      }

      process.exit(Number.isInteger(output.exitCode) ? output.exitCode : 0);
    }

    process.stdout.write(raw);
    process.exit(0);
  });
}
