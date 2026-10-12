#!/usr/bin/env node
/**
 * Mistral Vibe hooks adapter for the EGC Token Crusher.
 *
 * Vibe runs it as a pre_tool hook on its shell tools with the tool call as
 * JSON on stdin, and takes a full replacement of the model's arguments from
 * hook_specific_output.tool_input on stdout. The shared rewrite decision
 * (pre-bash-crusher-rewrite) says whether the command is worth routing
 * through `egc run`; when it is, the rewritten command goes back in that
 * envelope, otherwise stdout stays empty and the original command runs.
 * Fail-open: any error leaves the command untouched, and the entry is
 * installed with strict = false so a failure of the adapter itself does the
 * same. The adapter reads stdin on its own so the Crusher module needs no
 * file of the Guardian module next to it; the cap counts bytes, not
 * string length, the way the shared Guardian reader does.
 */

'use strict';

const { computeCrushedCommand } = require('./pre-bash-crusher-rewrite');
const { readHookStdin } = require('../lib/hook-stdin');

const SHELL_TOOL_RE = /^(bash|git_bash|experimental_bash|experimental_git_bash)$/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The replacement arguments for a Vibe shell call the Crusher rewrites, or
 * null when the command stays as it is.
 * @param {Record<string, unknown>} event
 * @returns {{hook_specific_output: {tool_input: Record<string, unknown>}}|null}
 */
function rewriteVibeEvent(event) {
  if (!isPlainObject(event) || typeof event.tool_name !== 'string' || !SHELL_TOOL_RE.test(event.tool_name.trim())) {
    return null;
  }
  const toolInput = isPlainObject(event.tool_input) ? event.tool_input : null;
  const command = toolInput?.command;
  if (typeof command !== 'string' || command === '') return null;
  const rewritten = computeCrushedCommand(command);
  if (rewritten === null) return null;
  return { hook_specific_output: { tool_input: { ...toolInput, command: rewritten } } };
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function main() {
  readHookStdin(({ raw, truncated }) => {
    if (!truncated) {
      const output = rewriteVibeEvent(parseJson(raw));
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    }
    process.exitCode = 0;
  });
}

if (require.main === module) {
  main();
}

module.exports = { rewriteVibeEvent };
