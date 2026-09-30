#!/usr/bin/env node
/**
 * Devin Desktop hooks adapter for the EGC Guardian command validator.
 *
 * Devin Local, the agent in Devin Desktop since Cascade was removed on
 * 2026-09-08, calls it as a PreToolUse hook matching ^exec$ (see
 * scripts/lib/devin-local-hooks.js): {hook_event_name, tool_name: "exec",
 * tool_input: {command}, cwd} on stdin. Cascade's pre_run_command shape,
 * {agent_action_name, tool_info: {command_line}}, is still read, since the
 * Devin CLI also loads a .windsurf/hooks.json written for it. Either way the
 * block is a plain exit code 2 with the reason on stderr.
 *
 * pre-bash-guardian-validate.js's own run() already returns {exitCode,
 * stderr} directly (no JSON envelope to unwrap), so unlike the GateGuard
 * adapter this translation only needs to build its input shape and relay
 * its output as-is. The Guardian validates shell commands, not file writes.
 */

'use strict';

const { run } = require('./pre-bash-guardian-validate');
const { bootstrapPlainExitCodeAdapter } = require('../lib/adapter-stdin-json');

// Devin Local, which replaced Cascade on 2026-09-08, sends the Claude Code
// shape instead (docs.devin.ai/cli/extensibility/hooks): PreToolUse with
// tool_name "exec" and tool_input.command, plus cwd at the top level.
function buildFromDevinLocalCall(event) {
  if (event.tool_name !== 'exec') {
    return null;
  }
  const toolInput = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!command) {
    return null;
  }
  const input = { tool_name: 'Bash', tool_input: { command } };
  if (typeof event.cwd === 'string') {
    input.cwd = event.cwd;
  }
  return input;
}

function buildGuardianInput(windsurfEvent) {
  if (!windsurfEvent || typeof windsurfEvent !== 'object') {
    return null;
  }
  if (windsurfEvent.hook_event_name === 'PreToolUse') {
    return buildFromDevinLocalCall(windsurfEvent);
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
  // process's own cwd instead of the directory Devin Desktop actually runs the
  // command in.
  const input = { tool_name: 'Bash', tool_input: { command } };
  if (typeof toolInfo.cwd === 'string') {
    input.cwd = toolInfo.cwd;
  }
  return input;
}

module.exports = bootstrapPlainExitCodeAdapter({
  isMain: require.main === module,
  buildGuardianInput,
  runGuardian: run,
});
