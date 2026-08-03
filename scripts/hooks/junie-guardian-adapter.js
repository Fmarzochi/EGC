#!/usr/bin/env node
/**
 * Junie CLI adapter for the EGC Guardian command validator.
 *
 * Junie's PreToolUse hook input already matches Claude Code's own shape
 * ({tool_name, tool_input: {command}}) -- confirmed against
 * junie.jetbrains.com/docs/junie-cli-hooks.html -- so no input remapping is
 * needed, unlike Cursor/Windsurf. Only the OUTPUT envelope differs: Junie
 * expects a FLAT {decision, reason, updatedInput} object on stdout, not
 * Claude Code's {hookSpecificOutput: {permissionDecision, updatedInput}}.
 * pre-bash-guardian-validate.js's own run() already returns {exitCode,
 * stderr} directly, so this only needs to translate that into Junie's
 * decision vocabulary ("allow" | "deny") plus exit code 2 to block
 * regardless of stdout, per the doc's documented alternative contract.
 */

'use strict';

const { run } = require('./pre-bash-guardian-validate');
const { runJsonEnvelopeGuardianAdapter } = require('../lib/adapter-stdin-json');

function buildGuardianInput(event) {
  const command = event && typeof event === 'object' ? event.tool_input?.command : undefined;
  if (!command) {
    return null;
  }
  const guardianInput = { tool_name: 'Bash', tool_input: { command } };
  if (event && typeof event.cwd === 'string') {
    guardianInput.cwd = event.cwd;
  }
  return guardianInput;
}

function respond(blocked, reason) {
  // Sets exitCode and lets Node drain stdout naturally instead of forcing
  // process.exit() right after write(): on POSIX, stdout writes to a pipe
  // (which is what a hook subprocess always has) are asynchronous, so a
  // forced exit can race the write and truncate the response before Junie
  // reads it (cubic-dev-ai finding, PR #1081).
  const decision = blocked ? 'deny' : 'allow';
  const payload = reason ? { decision, reason } : { decision };
  process.exitCode = blocked ? 2 : 0;
  process.stdout.write(JSON.stringify(payload));
}

function main() {
  runJsonEnvelopeGuardianAdapter(buildGuardianInput, run, respond);
}

if (require.main === module) {
  main();
}

module.exports = { buildGuardianInput };
