#!/usr/bin/env node
/**
 * Cursor-to-Gemini Code Hook Adapter
 * Transforms Cursor stdin JSON to Gemini Code hook format,
 * then delegates to existing scripts/hooks/*.js
 */

const { execFileSync } = require('child_process');
const path = require('path');

const MAX_STDIN = 1024 * 1024;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      if (data.length < MAX_STDIN) data += chunk.substring(0, MAX_STDIN - data.length);
    });
    process.stdin.on('end', () => resolve(data));
  });
}

function getPluginRoot() {
  return path.resolve(__dirname, '..', '..');
}

function transformToClaude(cursorInput, overrides = {}) {
  return {
    tool_input: {
      command: cursorInput.command || cursorInput.args?.command || '',
      file_path: cursorInput.path || cursorInput.file || cursorInput.args?.filePath || '',
      ...overrides.tool_input,
    },
    tool_output: {
      output: cursorInput.output || cursorInput.result || '',
      ...overrides.tool_output,
    },
    transcript_path: cursorInput.transcript_path || cursorInput.transcriptPath || cursorInput.session?.transcript_path || '',
    _cursor: {
      conversation_id: cursorInput.conversation_id,
      hook_event_name: cursorInput.hook_event_name,
      workspace_roots: cursorInput.workspace_roots,
      model: cursorInput.model,
    },
  };
}

function runExistingHook(scriptName, stdinData) {
  const scriptPath = path.join(getPluginRoot(), 'scripts', 'hooks', scriptName);
  try {
    execFileSync('node', [scriptPath], {
      input: typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
      cwd: process.cwd(),
    });
  } catch (e) {
    if (e.status === 2) process.exit(2); // Forward blocking exit code
  }
}

function hookEnabled(hookId, allowedProfiles = ['standard', 'strict']) {
  const rawProfile = String(process.env.EGC_HOOK_PROFILE || 'standard').toLowerCase();
  const profile = ['minimal', 'standard', 'strict'].includes(rawProfile) ? rawProfile : 'standard';

  const disabled = new Set(
    String(process.env.EGC_DISABLED_HOOKS || '')
      .split(',')
      .map(v => v.trim().toLowerCase())
      .filter(Boolean)
  );

  if (disabled.has(String(hookId || '').toLowerCase())) {
    return false;
  }

  return allowedProfiles.includes(profile);
}

// --- GateGuard fact-forcing gate translation ---
//
// gateguard-fact-force.js already speaks a Claude-Code-shaped dialect on its
// two existing call paths (bash-hook-dispatcher.js, and Gemini's
// run-with-flags.js): tool_name/tool_input in, and a deny signalled by an
// exit-0 stdout JSON blob (hookSpecificOutput.permissionDecision). Cursor's
// preToolUse hook uses the same tool_name/tool_input shape on input, but a
// different shape on output: a top-level `permission` field
// (allow/deny/ask) plus user_message/agent_message. These two functions are
// the translation layer between the two contracts. The hook IDs below match
// the literals gateguard-fact-force.js already embeds in its own
// recovery-hint text (the EGC_DISABLED_HOOKS targets), so disabling the gate
// via that env var works the same way across Claude Code, Gemini, and Cursor.
const GATEGUARD_EDIT_WRITE_HOOK_ID = 'pre:edit-write:gateguard-fact-force';
const GATEGUARD_BASH_HOOK_ID = 'pre:bash:gateguard-fact-force';

/**
 * Cursor's agent reports shell execution as tool_name "Shell", not "Bash".
 * gateguard-fact-force.js only recognizes "Bash" (case-insensitively), so
 * that one name needs remapping; every other tool_name passes through as-is
 * (Cursor's file-write tool is already named "Write", which matches).
 */
function normalizeCursorToolName(rawToolName) {
  const value = String(rawToolName || '');
  return value.toLowerCase() === 'shell' ? 'Bash' : value;
}

/**
 * Builds the Claude-shaped payload gateguard-fact-force.js's run() expects
 * out of a raw Cursor preToolUse stdin payload.
 */
function buildGateGuardInput(cursorInput) {
  const toolInput = (cursorInput && cursorInput.tool_input) || {};
  const filePath = toolInput.file_path || toolInput.path || toolInput.filePath || '';
  const payload = {
    tool_name: normalizeCursorToolName(cursorInput && cursorInput.tool_name),
    tool_input: {
      command: toolInput.command || '',
      file_path: filePath,
    },
    session_id: (cursorInput && cursorInput.conversation_id) || (cursorInput && cursorInput.session_id) || '',
    transcript_path: (cursorInput && cursorInput.transcript_path) || '',
  };
  if (Array.isArray(toolInput.edits)) {
    payload.tool_input.edits = toolInput.edits;
  }
  return payload;
}

/**
 * Translates gateguard-fact-force.js's run() return value into Cursor's
 * preToolUse output contract. run() returns one of:
 *   - the original payload object (allow, pass-through)
 *   - { stdout: '<json>', exitCode: 0 } where the JSON carries a deny decision
 *   - { stderr: '<warning>', exitCode: 0 } when gate state could not persist
 *     (fails open so a broken state dir never becomes a permanent block)
 */
function translateGateGuardResult(result) {
  if (result && typeof result === 'object' && typeof result.stdout === 'string') {
    try {
      const parsed = JSON.parse(result.stdout);
      const decision = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision;
      if (decision === 'deny') {
        const reason = parsed.hookSpecificOutput.permissionDecisionReason || '';
        return { permission: 'deny', user_message: reason, agent_message: reason };
      }
    } catch (_) {
      // Malformed JSON from the gate: fail open rather than block on our own bug.
    }
  }

  return { permission: 'allow' };
}

module.exports = {
  readStdin,
  getPluginRoot,
  transformToClaude,
  runExistingHook,
  hookEnabled,
  GATEGUARD_EDIT_WRITE_HOOK_ID,
  GATEGUARD_BASH_HOOK_ID,
  normalizeCursorToolName,
  buildGateGuardInput,
  translateGateGuardResult,
};
