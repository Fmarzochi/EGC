#!/usr/bin/env node
/**
 * Windsurf Cascade Hooks adapter for the GateGuard Fact-Forcing Gate.
 *
 * Windsurf's pre_write_code and pre_run_command hooks (docs:
 * https://docs.windsurf.com/windsurf/cascade/hooks, redirects to
 * https://docs.devin.ai/desktop/cascade/hooks) use a different wire contract
 * than Claude Code/Codex/Continue:
 *   - stdin JSON shape: {agent_action_name, tool_info: {...}}, not
 *     {tool_name, tool_input}
 *   - blocking signal: exit code 2 with the reason on stderr, not a
 *     hookSpecificOutput.permissionDecision:"deny" JSON object on stdout
 *
 * This script translates both directions so gateguard-fact-force.js's own
 * run() function (unchanged) can gate Windsurf's file edits and shell
 * commands too.
 */

'use strict';

const fs = require('fs');
const { run } = require('./gateguard-fact-force');

function buildGateGuardInput(windsurfEvent) {
  const actionName = windsurfEvent.agent_action_name || '';
  const toolInfo = windsurfEvent.tool_info || {};

  if (actionName === 'pre_write_code') {
    const filePath = toolInfo.file_path || '';
    if (!filePath) {
      return null;
    }
    // Windsurf reports every code write through the same event whether the
    // file already exists or is being created; gateguard-fact-force.js
    // phrases the two cases differently, so recover that distinction here.
    const toolName = fs.existsSync(filePath) ? 'Edit' : 'Write';
    return {
      session_id: windsurfEvent.trajectory_id || '',
      tool_name: toolName,
      tool_input: { file_path: filePath },
    };
  }

  if (actionName === 'pre_run_command') {
    const command = toolInfo.command_line || '';
    return {
      session_id: windsurfEvent.trajectory_id || '',
      tool_name: 'Bash',
      tool_input: { command },
    };
  }

  return null;
}

/**
 * @param {*} result - whatever gateguard-fact-force.js's run() returned
 * @returns {string|null} deny reason, or null if the action should proceed
 */
function extractDenyReason(result) {
  if (!result || typeof result !== 'object' || typeof result.stdout !== 'string') {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (_) {
    return null;
  }
  const output = parsed && parsed.hookSpecificOutput;
  if (output && output.permissionDecision === 'deny') {
    return String(output.permissionDecisionReason || 'Blocked by the GateGuard Fact-Forcing Gate.');
  }
  return null;
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
    } catch (_) {
      process.exit(0); // allow on parse error, same fail-open policy as gateguard-fact-force.js
    }

    const gateguardInput = buildGateGuardInput(windsurfEvent);
    if (!gateguardInput) {
      process.exit(0);
    }

    const result = run(JSON.stringify(gateguardInput));
    const denyReason = extractDenyReason(result);
    if (denyReason) {
      process.stderr.write(denyReason.endsWith('\n') ? denyReason : `${denyReason}\n`);
      process.exit(2);
    }

    process.exit(0);
  });
}

if (require.main === module) {
  main();
}

module.exports = { buildGateGuardInput, extractDenyReason };
