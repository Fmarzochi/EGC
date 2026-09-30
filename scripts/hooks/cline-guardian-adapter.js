#!/usr/bin/env node
/**
 * Cline (VS Code extension) adapter for the EGC Guardian command validator.
 *
 * Confirmed against the real cline/cline source (apps/vscode/src/core/hooks/
 * hook-factory.ts and templates.ts, fetched 2026-07-29): Cline discovers a
 * PreToolUse hook by looking for an EXECUTABLE file literally named
 * `PreToolUse` (no extension) inside `.clinerules/hooks/` (project scope) or
 * `~/Documents/Cline/Hooks/` (global scope), and spawns it directly -- there
 * is no hooks.json to merge into. Input on stdin is
 * `{ taskId, preToolUse: { toolName, parameters }, clineVersion, timestamp,
 * workspaceRoots, userId, model, ... }`; for a shell command, toolName is
 * `execute_command` and the command string is `parameters.command`. The
 * Cline SDK and CLI run the same file (they also look in .cline/hooks and
 * ~/.cline/hooks) with toolName `run_commands`, read below.
 *
 * Cline's hook output schema (validateHookOutput in hook-factory.ts) only
 * recognizes `cancel` (boolean), `contextModification` (string) and
 * `errorMessage` (string) -- there is no field to rewrite the command, so
 * only Guardian (block) is possible here, not the Token Crusher, the same
 * block-only status as Kiro and Devin Desktop. `cancel: true` blocks the tool
 * call; Cline's own runner treats hooks as fail-open (only an explicit
 * `cancel: true` blocks, a crashed/timed-out hook does not).
 */

'use strict';

const { run } = require('./pre-bash-guardian-validate');
const { runJsonEnvelopeGuardianAdapter } = require('../lib/adapter-stdin-json');

// The Cline SDK and CLI read the same .clinerules/hooks/PreToolUse, but name
// their shell tool run_commands (sdk/packages/core/src/runtime/orchestration/
// runtime-builder.ts maps execute_command and bash to it). Its input is one
// of the shapes of RunCommandsInputUnionSchema (extensions/tools/schemas.ts):
// a command string, a list of them, {command}, {cmd} or {commands}, where a
// command may also be {command, args} run without a shell. The payload
// carries the raw input in tool_call.input and a copy with every value
// turned into a string in preToolUse.parameters (hooks/hook-file-hooks.ts).
const RUN_COMMANDS_TOOL = 'run_commands';
const UNREADABLE_TOOL = 'UnreadableRunCommands';
const UNREADABLE_REASON = 'EGC Guardian BLOCKED this command: the run_commands input could not be read, '
  + 'so it could not be validated. Send the commands as a list of strings.';
const SHELL_SAFE_WORD = /^[\w@%+=:,./-]+$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function shellQuote(word) {
  return SHELL_SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

// The readings of one command the Guardian judges, or null when it cannot be
// read. {command} is either shell text or an executable (the schema accepts
// both), so the command part is never quoted. A {command, args} call runs
// without a shell: its argv is read with the args quoted, and read again as
// plain words, so the script of an interpreter (bash -c ...) is seen too.
function commandReadings(entry) {
  if (typeof entry === 'string') return [entry];
  if (!isPlainObject(entry) || typeof entry.command !== 'string' || !entry.command) return null;
  const args = entry.args === undefined ? [] : entry.args;
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) return null;
  const quoted = [entry.command, ...args.map(shellQuote)].join(' ');
  const plain = [entry.command, ...args].join(' ');
  return quoted === plain ? [quoted] : [quoted, plain];
}

function commandList(value) {
  const entries = Array.isArray(value) ? value : [value];
  const readings = entries.map(commandReadings);
  return readings.includes(null) ? null : readings.flat().filter(command => command.trim().length > 0);
}

// Every command a run_commands input asks for, or null when unreadable.
// Every key the schema knows is read, so no command hides behind another.
function runCommandsOf(input) {
  if (!isPlainObject(input)) return commandList(input);
  const parts = ['commands', 'cmd'].filter(key => input[key] !== undefined).map(key => commandList(input[key]));
  if (input.command !== undefined || parts.length === 0) parts.push(commandList(input));
  return parts.includes(null) ? null : parts.flat();
}

// preToolUse.parameters holds JSON text for every value that was not a
// string; read it back, keeping plain text as the command itself.
function parsedParameter(value) {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : value;
  } catch {
    return value;
  }
}

function runCommandsInput(event) {
  if (isPlainObject(event.tool_call) && event.tool_call.input !== undefined) {
    return event.tool_call.input;
  }
  const parameters = isPlainObject(event.preToolUse?.parameters) ? event.preToolUse.parameters : {};
  return Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, parsedParameter(value)]));
}

function buildGuardianInput(event) {
  if (!isPlainObject(event)) return null;
  const toolName = event.preToolUse?.toolName ?? event.tool_call?.name;
  if (toolName === RUN_COMMANDS_TOOL) {
    const commands = runCommandsOf(runCommandsInput(event));
    if (commands === null) return { tool_name: UNREADABLE_TOOL };
    return commands.length > 0 ? { tool_name: 'Bash', commands } : null;
  }
  const command = toolName === 'execute_command'
    ? event.preToolUse?.parameters?.command ?? event.tool_call?.input?.command
    : undefined;
  if (!command || typeof command !== 'string') {
    return null;
  }
  return { tool_name: 'Bash', tool_input: { command } };
}

// Judges each command of a run_commands call on its own and stops at the
// first the Guardian blocks.
function runGuardian(input) {
  if (input.tool_name === UNREADABLE_TOOL) return { exitCode: 2, stderr: UNREADABLE_REASON };
  if (!Array.isArray(input.commands)) return run(input);
  for (const command of input.commands) {
    const result = run({ tool_name: 'Bash', tool_input: { command } });
    if (result.exitCode === 2) return result;
  }
  return { exitCode: 0, stderr: '' };
}

function respond(cancel, errorMessage) {
  // process.exitCode (not process.exit()) so Node drains stdout naturally:
  // on POSIX a forced exit can race the pipe write and truncate the
  // response before Cline reads it (same cubic-dev-ai finding applied to
  // every EGC translation adapter, PR #1081).
  const payload = errorMessage ? { cancel, errorMessage } : { cancel };
  process.exitCode = 0;
  process.stdout.write(JSON.stringify(payload));
}

function main() {
  runJsonEnvelopeGuardianAdapter(buildGuardianInput, runGuardian, respond);
}

if (require.main === module) {
  main();
}

module.exports = { buildGuardianInput };
