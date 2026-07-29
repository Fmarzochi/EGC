#!/usr/bin/env node
/**
 * Windsurf Cascade Hooks adapter for the EGC Guardian command validator.
 *
 * Windsurf's pre_run_command hook uses a different wire contract than Claude
 * Code's PreToolUse hook (see windsurf-gateguard-adapter.js for the same
 * distinction this file mirrors): {agent_action_name, tool_info:
 * {command_line}} on stdin instead of {tool_name, tool_input}, and a plain
 * exit-code-2-with-stderr block instead of a hookSpecificOutput JSON
 * envelope on stdout.
 *
 * pre-bash-guardian-validate.js's own run() already returns {exitCode,
 * stderr} directly (no JSON envelope to unwrap), so unlike the GateGuard
 * adapter this translation only needs to build its input shape and relay
 * its output as-is.
 *
 * Registered only on Windsurf's pre_run_command event (not
 * pre_write_code) — the Guardian validates shell commands, not file writes.
 */

'use strict';

const { run } = require('./pre-bash-guardian-validate');
const { runPlainExitCodeGuardianAdapter } = require('../lib/adapter-stdin-json');

function buildGuardianInput(windsurfEvent) {
  if (!windsurfEvent || typeof windsurfEvent !== 'object') {
    return null;
  }
  const actionName = windsurfEvent.agent_action_name || '';
  if (actionName !== 'pre_run_command') {
    return null;
  }
  const toolInfo = windsurfEvent.tool_info || {};
  const command = toolInfo.command_line || '';
  if (!command) {
    return null;
  }
  // cwd matters here (unlike for GateGuard's fact-forcing gate): the
  // Guardian resolves relative protected paths (e.g. `cat .ssh/id_rsa`)
  // against it. Without it, those checks fall back to this adapter
  // process's own cwd instead of the directory Windsurf actually runs the
  // command in.
  const input = { tool_name: 'Bash', tool_input: { command } };
  if (typeof toolInfo.cwd === 'string') {
    input.cwd = toolInfo.cwd;
  }
  return input;
}

function main() {
  runPlainExitCodeGuardianAdapter(buildGuardianInput, run);
}

if (require.main === module) {
  main();
}

module.exports = { buildGuardianInput };
