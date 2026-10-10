#!/usr/bin/env node
/**
 * Antigravity hooks adapter for the GateGuard Fact-Forcing Gate.
 *
 * Antigravity (the CLI, the IDE and Antigravity 2.0) runs a PreToolUse hook
 * with {toolCall: {name, args}, conversationId, workspacePaths, ...} on
 * stdin and reads a {decision, reason} object on stdout
 * (antigravity.google/docs/hooks). Shell commands arrive as run_command
 * {CommandLine, Cwd}; file writes as write_to_file, replace_file_content
 * and multi_replace_file_content, each with a TargetFile. The call is handed
 * to gateguard-fact-force.js's own run(), in the shape it reads for Claude
 * Code, and the answer is:
 *   - "deny" with the gate's reason (the facts it asks for) when the gate
 *     refuses the call;
 *   - "ask" otherwise, which Antigravity treats exactly as having no hook.
 * Measured on agy 1.2.12 (2026-09-28): a hook that prints no decision denies
 * the call, so every path answers.
 *
 * The session key is Antigravity's conversationId. The transcript Antigravity
 * names is not handed to the gate: the gate reads Claude Code's JSONL
 * transcript to judge whether the facts were presented, and reading another
 * format as that one would refuse every retry three times before stepping
 * aside. Without a transcript the gate keeps its identical-retry rule: the
 * first call is refused with the facts to present, the identical retry
 * passes. A payload cut at the reader's size cap is denied, as in every
 * adapter.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./gateguard-fact-force');
const { runJsonEnvelopeGuardianAdapter } = require('../lib/adapter-stdin-json');

const SHELL_TOOL = 'run_command';
const WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);
const DEFAULT_DENY_REASON = 'Blocked by the GateGuard Fact-Forcing Gate.';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function firstWorkspace(event) {
  const paths = event.workspacePaths;
  return Array.isArray(paths) && typeof paths[0] === 'string' ? paths[0] : '';
}

// A relative target is Antigravity's, relative to its workspace, not to
// the directory this hook process runs in.
function targetOf(event, args) {
  const target = nonEmptyString(args.TargetFile);
  if (!target || path.isAbsolute(target)) return target;
  const workspace = firstWorkspace(event);
  return workspace ? path.resolve(workspace, target) : target;
}

// The gate phrases a creation and an edit differently; the file on disk
// decides, as in the Devin Desktop adapter.
function fileToolName(filePath) {
  return fs.existsSync(filePath) ? 'Edit' : 'Write';
}

function buildGateGuardInput(event) {
  if (!isPlainObject(event) || !isPlainObject(event.toolCall)) return null;
  const { name } = event.toolCall;
  const args = isPlainObject(event.toolCall.args) ? event.toolCall.args : {};
  const sessionId = nonEmptyString(event.conversationId);
  if (name === SHELL_TOOL) {
    const command = nonEmptyString(args.CommandLine);
    return command ? { session_id: sessionId, tool_name: 'Bash', tool_input: { command } } : null;
  }
  if (!WRITE_TOOLS.has(name)) return null;
  const target = targetOf(event, args);
  return target ? { session_id: sessionId, tool_name: fileToolName(target), tool_input: { file_path: target } } : null;
}

// The deny reason of what gateguard-fact-force.js's run() returned, null
// when the call may proceed. Malformed stdout from run() is no denial, the
// same fail-open policy the gate applies to its own parse failures.
function extractDenyReason(result) {
  if (!result || typeof result !== 'object' || typeof result.stdout !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const output = parsed?.hookSpecificOutput;
  if (output?.permissionDecision === 'deny') {
    return String(output.permissionDecisionReason || DEFAULT_DENY_REASON);
  }
  return null;
}

// The shared envelope flow reads a Guardian-shaped verdict: exit code 2 with
// the reason on stderr is a block.
function runGate(input) {
  const reason = extractDenyReason(run(JSON.stringify(input)));
  return reason ? { exitCode: 2, stderr: reason } : { exitCode: 0 };
}

function respond(blocked, message) {
  const payload = blocked
    ? { decision: 'deny', reason: message || DEFAULT_DENY_REASON }
    : { decision: 'ask' };
  process.exitCode = 0;
  process.stdout.write(JSON.stringify(payload));
}

if (require.main === module) {
  runJsonEnvelopeGuardianAdapter(buildGateGuardInput, runGate, respond);
}

module.exports = { buildGateGuardInput, extractDenyReason, respond };
