#!/usr/bin/env node
/**
 * Antigravity hooks adapter for the EGC Guardian.
 *
 * Antigravity (the CLI, the IDE and Antigravity 2.0) runs a PreToolUse hook
 * with {toolCall: {name, args}, workspacePaths, ...} on stdin and reads a
 * {decision, reason} object on stdout (antigravity.google/docs/hooks).
 * Shell commands arrive as run_command {CommandLine, Cwd}; file writes as
 * write_to_file {TargetFile, CodeContent}, replace_file_content {TargetFile,
 * TargetContent, ReplacementContent} and multi_replace_file_content
 * {TargetFile, ReplacementChunks}. Each call is handed to the Guardian
 * validator that already judges it for Claude Code, in the shape that
 * validator reads, and the answer is:
 *   - "deny" with the Guardian's reason when the Guardian blocks, and when a
 *     guarded call carries an argument that cannot be read as text;
 *   - "ask" otherwise.
 * Measured on agy 1.2.12 (2026-09-28): a hook that prints no decision denies
 * the call, "allow" would override the user's own permission settings, and
 * "ask" behaves exactly as having no hook (the call runs under
 * --dangerously-skip-permissions and waits for approval otherwise).
 * A payload cut at the reader's size cap is denied, as in every adapter.
 */

'use strict';

const { run: runBashGuardian } = require('./pre-bash-guardian-validate');
const { run: runWriteGuardian } = require('./pre-write-guardian-validate');
const { runJsonEnvelopeGuardianAdapter } = require('../lib/adapter-stdin-json');

const SHELL_TOOL = 'run_command';
const WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);
const UNREADABLE_TOOL = 'Unreadable';
const UNREADABLE_REASON = "EGC Guardian could not read this call's arguments as text, so it did not let the call run. Retry it with plain text arguments.";

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstWorkspace(event) {
  const paths = event.workspacePaths;
  return Array.isArray(paths) && typeof paths[0] === 'string' ? paths[0] : null;
}

function withCwd(input, cwd) {
  return typeof cwd === 'string' && cwd ? { ...input, cwd } : input;
}

const isOptionalString = value => value === undefined || typeof value === 'string';

// A chunk the validator cannot read as text makes the whole call unreadable.
function editOf(chunk) {
  if (!isPlainObject(chunk) || typeof chunk.ReplacementContent !== 'string' || !isOptionalString(chunk.TargetContent)) return null;
  return {
    old_string: chunk.TargetContent ?? '',
    new_string: chunk.ReplacementContent,
    replace_all: chunk.AllowMultiple === true,
  };
}

// The write validator reads Claude Code's Write/Edit/MultiEdit fields: the
// target, and the resulting content when the target is a shell script.
// null means an argument could not be read as text.
function writeToolInput(name, args) {
  const target = args.TargetFile;
  if (typeof target !== 'string' || !target) return null;
  if (name === 'write_to_file') {
    if (!isOptionalString(args.CodeContent)) return null;
    return args.CodeContent === undefined ? { file_path: target } : { file_path: target, content: args.CodeContent };
  }
  if (name === 'replace_file_content') {
    if (args.ReplacementContent === undefined) return { file_path: target };
    const edit = editOf(args);
    return edit ? { file_path: target, ...edit } : null;
  }
  const chunks = args.ReplacementChunks ?? [];
  if (!Array.isArray(chunks)) return null;
  const edits = chunks.map(editOf);
  return edits.includes(null) ? null : { file_path: target, edits };
}

function shellInput(event, args) {
  const command = args.CommandLine;
  if (typeof command !== 'string' || !command) return null;
  return withCwd({ tool_name: 'Bash', tool_input: { command } }, typeof args.Cwd === 'string' ? args.Cwd : firstWorkspace(event));
}

function writeInput(event, name, args) {
  const toolInput = writeToolInput(name, args);
  return toolInput ? withCwd({ tool_name: 'Write', tool_input: toolInput }, firstWorkspace(event)) : null;
}

// A guarded tool whose arguments cannot be read is denied rather than left
// to the user: the Guardian cannot judge what it cannot read.
function buildGuardianInput(event) {
  if (!isPlainObject(event) || !isPlainObject(event.toolCall)) return null;
  const { name } = event.toolCall;
  if (name !== SHELL_TOOL && !WRITE_TOOLS.has(name)) return null;
  const args = isPlainObject(event.toolCall.args) ? event.toolCall.args : {};
  const input = name === SHELL_TOOL ? shellInput(event, args) : writeInput(event, name, args);
  return input || { tool_name: UNREADABLE_TOOL };
}

function runGuardian(input) {
  if (input.tool_name === UNREADABLE_TOOL) return { exitCode: 2, stderr: UNREADABLE_REASON };
  return input.tool_name === 'Bash' ? runBashGuardian(input) : runWriteGuardian(input);
}

function respond(blocked, message) {
  const payload = blocked
    ? { decision: 'deny', reason: message || 'Blocked by the EGC Guardian.' }
    : { decision: 'ask' };
  process.exitCode = 0;
  process.stdout.write(JSON.stringify(payload));
}

if (require.main === module) {
  runJsonEnvelopeGuardianAdapter(buildGuardianInput, runGuardian, respond);
}

module.exports = { buildGuardianInput, respond };
