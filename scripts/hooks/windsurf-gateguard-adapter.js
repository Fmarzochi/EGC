#!/usr/bin/env node
/**
 * Devin Desktop hooks adapter for the GateGuard Fact-Forcing Gate.
 *
 * Devin Local, the agent in Devin Desktop since Cascade was removed on
 * 2026-09-08, calls it as a PreToolUse hook (see
 * scripts/lib/devin-local-hooks.js) with {hook_event_name, tool_name,
 * tool_input, session_id} on stdin. Cascade's pre_write_code and
 * pre_run_command shape, {agent_action_name, tool_info: {...}}, is still
 * read, since the Devin CLI also loads a .windsurf/hooks.json written for
 * it. Either way the block is exit code 2 with the reason on stderr, not a
 * hookSpecificOutput.permissionDecision:"deny" JSON object on stdout.
 *
 * This script translates both directions so gateguard-fact-force.js's own
 * run() function (unchanged) can gate Devin Desktop's file edits and shell
 * commands too.
 */

'use strict';

const fs = require('node:fs');
const { run } = require('./gateguard-fact-force');
const { readAdapterStdinJson } = require('../lib/adapter-stdin-json');

// Devin Local, which replaced Cascade on 2026-09-08, sends the Claude Code
// shape instead: {hook_event_name: "PreToolUse", tool_name, tool_input,
// session_id} (docs.devin.ai/cli/extensibility/hooks). `devin migrate
// hooks` maps pre_run_command to exec and pre_write_code to edit, write and
// notebook_edit; multi_edit and apply_patch write files too. The patch text
// is found by its own grammar marker rather than a field name the vendor
// does not document.
const DEVIN_PATCH_MARKER = '*** Begin Patch';

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function fileWriteInput(sessionId, filePath) {
  if (!filePath) {
    return null;
  }
  // Same Edit/Write split as pre_write_code below.
  const toolName = fs.existsSync(filePath) ? 'Edit' : 'Write';
  return { session_id: sessionId, tool_name: toolName, tool_input: { file_path: filePath } };
}

// Every file a multi_edit touches: the top-level file_path and any file_path
// given per edit, so no file of the call escapes the gate.
function multiEditPaths(toolInput) {
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
  const paths = [nonEmptyString(toolInput.file_path), ...edits.map(edit => (edit ? nonEmptyString(edit.file_path) : ''))];
  return [...new Set(paths.filter(Boolean))];
}

function multiEditInput(sessionId, toolInput) {
  const paths = multiEditPaths(toolInput);
  if (paths.length <= 1) {
    return fileWriteInput(sessionId, paths[0] || '');
  }
  // gateguard-fact-force.js gates each edits[].file_path of a MultiEdit.
  return { session_id: sessionId, tool_name: 'MultiEdit', tool_input: { edits: paths.map(filePath => ({ file_path: filePath })) } };
}

function findPatchText(toolInput) {
  if (typeof toolInput === 'string') {
    return toolInput.includes(DEVIN_PATCH_MARKER) ? toolInput : '';
  }
  return Object.values(toolInput).find(value => typeof value === 'string' && value.includes(DEVIN_PATCH_MARKER)) || '';
}

const DEVIN_LOCAL_TOOL_MAPPERS = {
  exec: (sessionId, toolInput) => {
    const command = nonEmptyString(toolInput.command);
    return command ? { session_id: sessionId, tool_name: 'Bash', tool_input: { command } } : null;
  },
  edit: (sessionId, toolInput) => fileWriteInput(sessionId, nonEmptyString(toolInput.file_path)),
  write: (sessionId, toolInput) => fileWriteInput(sessionId, nonEmptyString(toolInput.file_path)),
  notebook_edit: (sessionId, toolInput) => fileWriteInput(
    sessionId,
    nonEmptyString(toolInput.notebook_path) || nonEmptyString(toolInput.file_path)
  ),
  multi_edit: multiEditInput,
  apply_patch: (sessionId, toolInput) => {
    const patchText = findPatchText(toolInput);
    return patchText ? { session_id: sessionId, tool_name: 'apply_patch', tool_input: patchText } : null;
  },
};

function buildFromDevinLocalCall(event) {
  const toolName = typeof event.tool_name === 'string' ? event.tool_name : '';
  if (!Object.hasOwn(DEVIN_LOCAL_TOOL_MAPPERS, toolName)) {
    return null;
  }
  const rawInput = event.tool_input;
  const isUsable = typeof rawInput === 'string' || (rawInput !== null && typeof rawInput === 'object');
  if (!isUsable) {
    return null;
  }
  // Only apply_patch takes a bare string; every other tool reads fields.
  const toolInput = typeof rawInput === 'string' && toolName !== 'apply_patch' ? {} : rawInput;
  return DEVIN_LOCAL_TOOL_MAPPERS[toolName](nonEmptyString(event.session_id), toolInput);
}

function buildGateGuardInput(windsurfEvent) {
  if (windsurfEvent?.hook_event_name === 'PreToolUse') {
    return buildFromDevinLocalCall(windsurfEvent);
  }
  const actionName = windsurfEvent.agent_action_name || '';
  const toolInfo = windsurfEvent.tool_info || {};

  if (actionName === 'pre_write_code') {
    const filePath = toolInfo.file_path || '';
    if (!filePath) {
      return null;
    }
    // Devin Desktop reports every code write through the same event whether the
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
  } catch {
    // Malformed stdout from run() is treated as "no deny decision" -- the
    // same fail-open policy gateguard-fact-force.js applies to its own
    // parse failures, so a non-JSON stdout never blocks Devin Desktop's action.
    return null;
  }
  const output = parsed?.hookSpecificOutput;
  if (output?.permissionDecision === 'deny') {
    return String(output.permissionDecisionReason || 'Blocked by the GateGuard Fact-Forcing Gate.');
  }
  return null;
}

function main() {
  readAdapterStdinJson(({ ok, truncated, value }) => {
    // Checked before ok, unconditionally: a capped-length prefix can still
    // happen to be syntactically valid JSON, which would otherwise reach
    // the ok:true branch below with truncated data treated as trusted. The
    // hand-rolled reader this replaced had no truncation tracking at all
    // and silently allowed on any payload past the 1MB cap (EGC-539 audit).
    if (truncated) {
      process.stderr.write(
        'EGC Guardian BLOCKED this command: the event payload exceeded the size ' +
        'this validator can safely read, so it could not be parsed or validated. ' +
        'Simplify the command.\n'
      );
      process.exit(2);
    }
    if (!ok) {
      // Allow on parse error: same fail-open policy as gateguard-fact-force.js.
      process.exit(0);
    }

    const gateguardInput = buildGateGuardInput(value);
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
