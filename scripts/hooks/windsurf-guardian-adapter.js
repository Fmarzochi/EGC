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

function buildGuardianInput(windsurfEvent) {
  const actionName = windsurfEvent.agent_action_name || '';
  if (actionName !== 'pre_run_command') {
    return null;
  }
  const command = (windsurfEvent.tool_info || {}).command_line || '';
  if (!command) {
    return null;
  }
  return { tool_name: 'Bash', tool_input: { command } };
}

function main() {
  const MAX_STDIN = 1024 * 1024;
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      raw += chunk.substring(0, MAX_STDIN - raw.length);
    }
  });
  process.stdin.on('end', () => {
    let windsurfEvent;
    try {
      windsurfEvent = JSON.parse(raw);
    } catch {
      // Allow on parse error: same fail-open policy as the other adapters.
      process.exit(0);
    }

    const guardianInput = buildGuardianInput(windsurfEvent);
    if (!guardianInput) {
      process.exit(0);
    }

    const result = run(guardianInput);
    if (result.exitCode === 2) {
      const reason = result.stderr || 'Blocked by the EGC Guardian.';
      process.stderr.write(reason.endsWith('\n') ? reason : `${reason}\n`);
      process.exit(2);
    }

    process.exit(0);
  });
}

if (require.main === module) {
  main();
}

module.exports = { buildGuardianInput };
