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
 *   - "deny" with the Guardian's reason when the Guardian blocks;
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

function editOf(chunk) {
  if (!isPlainObject(chunk) || typeof chunk.ReplacementContent !== 'string') return null;
  return {
    old_string: typeof chunk.TargetContent === 'string' ? chunk.TargetContent : '',
    new_string: chunk.ReplacementContent,
    replace_all: chunk.AllowMultiple === true,
  };
}

// The write validator reads Claude Code's Write/Edit/MultiEdit fields: the
// target, and the resulting content when the target is a shell script.
function writeToolInput(name, args) {
  const target = args.TargetFile;
  if (typeof target !== 'string' || !target) return null;
  if (name === 'write_to_file') {
    return typeof args.CodeContent === 'string' ? { file_path: target, content: args.CodeContent } : { file_path: target };
  }
  if (name === 'replace_file_content') {
    const edit = editOf(args);
    return edit ? { file_path: target, ...edit } : { file_path: target };
  }
  const chunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [];
  return { file_path: target, edits: chunks.map(editOf).filter(Boolean) };
}

function buildGuardianInput(event) {
  if (!isPlainObject(event) || !isPlainObject(event.toolCall)) return null;
  const { name } = event.toolCall;
  const args = isPlainObject(event.toolCall.args) ? event.toolCall.args : {};
  if (name === SHELL_TOOL) {
    const command = args.CommandLine;
    if (typeof command !== 'string' || !command) return null;
    return withCwd({ tool_name: 'Bash', tool_input: { command } }, typeof args.Cwd === 'string' ? args.Cwd : firstWorkspace(event));
  }
  if (WRITE_TOOLS.has(name)) {
    const toolInput = writeToolInput(name, args);
    return toolInput ? withCwd({ tool_name: 'Write', tool_input: toolInput }, firstWorkspace(event)) : null;
  }
  return null;
}

function runGuardian(input) {
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
