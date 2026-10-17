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
 *
 * Thin orchestrator over four split modules: session-state persistence
 * (gateguard-state), Bash-command classification (gateguard-bash-classify),
 * path exemptions and gate message templates (gateguard-gate-rules), and
 * whether a retry's preceding message actually presented the demanded facts
 * (gateguard-retry-judge). The exported run() and the file's own path stay
 * exactly as they were, so nothing that requires this module needs to change.
 */

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { exitOnTruncatedInput, readHookStdin } = require('../lib/hook-stdin');
const { trace } = require('../lib/utils');
const {
  ROUTINE_BASH_SESSION_KEY,
  pendingKey,
  isGateGuardDisabled,
  resetActiveStateFile,
  getStateFile,
  markChecked,
  isChecked,
} = require('./gateguard-state');
const {
  DESTRUCTIVE_ANCHORS,
  commandWord,
  isDestructiveBash,
  isReadOnlyGitIntrospection,
} = require('./gateguard-bash-classify');
const {
  BASH_HOOK_ID,
  sanitizePath,
  isGateExemptPath,
  editGateMsg,
  writeGateMsg,
  destructiveBashMsg,
  routineBashMsg,
  denyResult,
  allowWithStateWarning,
} = require('./gateguard-gate-rules');
const { setHookInput, refuseUnpresentedFacts } = require('./gateguard-retry-judge');

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
  if (!filePath || isGateExemptPath(filePath)) {
    trace('governance:allowed:settings', { toolName, filePath });
    return rawInput;
  }

  if (!isChecked(filePath)) {
    if (!markChecked(filePath) || !markChecked(pendingKey(filePath))) {
      trace('governance:allowed:state_error', { toolName, filePath });
      return allowWithStateWarning();
    }
    trace('governance:denied:fact_force', { toolName, filePath });
    return denyResult(toolName === 'Edit' ? editGateMsg(filePath) : writeGateMsg(filePath));
  }
  const refused = refuseUnpresentedFacts(filePath, [path.basename(filePath)], { toolName, filePath }, { anchorTerms: [sanitizePath(filePath)], target: sanitizePath(filePath) });
  if (refused) return refused;
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
    if (!filePath || isGateExemptPath(filePath)) continue;
    if (!isChecked(filePath)) {
      if (!markChecked(filePath) || !markChecked(pendingKey(filePath))) {
        trace('governance:allowed:state_error', { toolName, filePath });
        return allowWithStateWarning();
      }
      trace('governance:denied:fact_force', { toolName, filePath });
      return denyResult(editGateMsg(filePath));
    }
    const refused = refuseUnpresentedFacts(filePath, [path.basename(filePath)], { toolName, filePath }, { anchorTerms: [sanitizePath(filePath)], target: sanitizePath(filePath) });
    if (refused) return refused;
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
 * fact-forcing gate can apply per file. A `*** Move to:` line names the file
 * an update is renamed to, which is written as a new file.
 *
 * @param {string} patchText
 * @returns {string[]}
 */
function extractApplyPatchFilePaths(patchText) {
  const text = String(patchText || '');
  const pattern = /^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+)$/gm;
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
// Codex sends the patch as tool_input.command (codex-rs/core/src/tools/
// handlers/apply_patch.rs, pre_tool_use_payload); the Devin adapter hands it
// over as a bare string.
function applyPatchTextOf(rawPatchInput) {
  if (typeof rawPatchInput === 'string') return rawPatchInput;
  return typeof rawPatchInput?.command === 'string' ? rawPatchInput.command : '';
}

function handleApplyPatch(rawInput, rawPatchInput) {
  const patchText = applyPatchTextOf(rawPatchInput);
  const filePaths = extractApplyPatchFilePaths(patchText);
  if (filePaths.length === 0) {
    trace('governance:allowed:apply_patch_unparsed');
    return rawInput;
  }

  for (const filePath of filePaths) {
    if (isGateExemptPath(filePath) || isChecked(filePath)) {
      continue;
    }
    if (!markChecked(filePath) || !markChecked(pendingKey(filePath))) {
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

  if (isDestructiveBash(command)) {
    const key = '__destructive__' + crypto.createHash('sha256').update(command).digest('hex').slice(0, 16);
    if (!isChecked(key)) {
      if (!markChecked(key) || !markChecked(pendingKey(key))) {
        trace('governance:allowed:state_error', { toolName, command });
        return allowWithStateWarning();
      }
      trace('governance:denied:destructive', { command });
      return denyResult(destructiveBashMsg(), { includeRecoveryHint: false });
    }
    const refused = refuseUnpresentedFacts(key, ['rollback', commandWord(command)], { command }, { anchorTerms: DESTRUCTIVE_ANCHORS, target: 'this command' });
    if (refused) return refused;
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
  } catch (_) { // NOSONAR: parse failure allows the command through by design
    return rawInput; // allow on parse error
  }

  if (isGateGuardDisabled()) {
    trace('governance:disabled');
    return rawInput;
  }

  resetActiveStateFile();
  setHookInput(data);
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
  readHookStdin(({ raw, truncated }) => {
    exitOnTruncatedInput(truncated, 2);
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
