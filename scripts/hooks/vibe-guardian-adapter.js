#!/usr/bin/env node
/**
 * Mistral Vibe hooks adapter for the EGC Guardian.
 *
 * Vibe runs a [[hooks]] entry of type pre_tool from hooks.toml with one JSON
 * object on stdin ({session_id, cwd, hook_event_name, tool_name,
 * tool_call_id, tool_input}) and reads the answer from stdout: nothing means
 * allow, an object with decision "deny" and a reason denies the call, and
 * the reason becomes the tool error the model sees. A non-zero exit is a
 * hook failure, not a denial, so this adapter always exits 0 and speaks the
 * JSON contract; the entry is installed with strict = true, which turns a
 * failure of the adapter itself into a denial.
 *
 * Routing by tool name (Vibe names a tool after its class in snake_case):
 *   - bash, git_bash, experimental_bash, experimental_git_bash -> the Bash Guardian
 *   - edit -> the write Guardian, on file_path
 */

'use strict';

const { run: runBashGuardian } = require('./pre-bash-guardian-validate');
const { run: runWriteGuardian } = require('./pre-write-guardian-validate');
const { runJsonEnvelopeGuardianAdapter } = require('../lib/adapter-stdin-json');

const SHELL_TOOL_RE = /^(bash|git_bash|experimental_bash|experimental_git_bash)$/i;
const EDIT_TOOL_RE = /^edit$/i;
const TRUNCATED_REASON = 'EGC Guardian BLOCKED this tool call: the event payload exceeded the size '
  + 'this validator can safely read, so it could not be parsed or validated.';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The Guardian input a Vibe pre_tool event maps to, or null for a tool the
 * Guardian does not judge.
 * @param {Record<string, unknown>} event
 * @returns {{kind: 'bash'|'write', input: Record<string, unknown>}|null}
 */
function buildGuardianInput(event) {
  if (!isPlainObject(event) || typeof event.tool_name !== 'string') return null;
  const toolName = event.tool_name.trim();
  const toolInput = isPlainObject(event.tool_input) ? { ...event.tool_input } : {};
  const cwd = typeof event.cwd === 'string' ? { cwd: event.cwd } : {};
  if (SHELL_TOOL_RE.test(toolName)) {
    if (typeof toolInput.command !== 'string') return null;
    return { kind: 'bash', input: { tool_name: 'Bash', tool_input: toolInput, ...cwd } };
  }
  if (EDIT_TOOL_RE.test(toolName)) {
    const target = toolInput.file_path || toolInput.path;
    if (typeof target !== 'string') return null;
    return {
      kind: 'write',
      input: { tool_name: 'Edit', tool_input: { ...toolInput, file_path: target, path: target }, ...cwd },
    };
  }
  return null;
}

function runGuardian(target, options) {
  return target.kind === 'bash' ? runBashGuardian(target.input, options) : runWriteGuardian(target.input, options);
}

// Vibe's answer: silence allows, an object with decision "deny" and the
// Guardian's reason denies. process.exitCode, never process.exit(), so the
// object drains to stdout before the process ends.
function respond(blocked, message) {
  if (blocked) {
    process.stdout.write(`${JSON.stringify({ decision: 'deny', reason: message || 'Blocked by the EGC Guardian.' })}\n`);
  }
  process.exitCode = 0;
}

/**
 * The decision for one event object or JSON string, for tests.
 * @param {Record<string, unknown>|string} eventOrRaw
 * @param {Record<string, unknown>} [options]
 * @returns {{blocked: boolean, reason?: string}}
 */
function runVibeGuardianAdapter(eventOrRaw, options = {}) {
  if (options.truncated) return { blocked: true, reason: TRUNCATED_REASON };
  let event = eventOrRaw;
  if (typeof event === 'string') {
    try {
      event = JSON.parse(event);
    } catch {
      return { blocked: false };
    }
  }
  const target = buildGuardianInput(event);
  if (!target) return { blocked: false };
  const result = runGuardian(target, options);
  if (result?.exitCode === 2) return { blocked: true, reason: result.stderr || 'Blocked by the EGC Guardian.' };
  return { blocked: false };
}

if (require.main === module) {
  runJsonEnvelopeGuardianAdapter(buildGuardianInput, target => runGuardian(target), respond);
}

module.exports = { buildGuardianInput, runVibeGuardianAdapter };
