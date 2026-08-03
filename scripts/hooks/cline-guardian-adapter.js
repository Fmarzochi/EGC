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
 * `execute_command` and the command string is `parameters.command`.
 *
 * Cline's hook output schema (validateHookOutput in hook-factory.ts) only
 * recognizes `cancel` (boolean), `contextModification` (string) and
 * `errorMessage` (string) -- there is no field to rewrite the command, so
 * only Guardian (block) is possible here, not the Token Crusher, the same
 * block-only status as Kiro and Windsurf. `cancel: true` blocks the tool
 * call; Cline's own runner treats hooks as fail-open (only an explicit
 * `cancel: true` blocks, a crashed/timed-out hook does not).
 */

'use strict';

const { run } = require('./pre-bash-guardian-validate');
const { runJsonEnvelopeGuardianAdapter } = require('../lib/adapter-stdin-json');

function buildGuardianInput(event) {
  const toolName = event && typeof event === 'object' ? event.preToolUse?.toolName : undefined;
  const command = toolName === 'execute_command' ? event.preToolUse?.parameters?.command : undefined;
  if (!command || typeof command !== 'string') {
    return null;
  }
  return { tool_name: 'Bash', tool_input: { command } };
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
  runJsonEnvelopeGuardianAdapter(buildGuardianInput, run, respond);
}

if (require.main === module) {
  main();
}

module.exports = { buildGuardianInput };
