#!/usr/bin/env node
/**
 * Junie CLI adapter for the Token Crusher.
 *
 * Same input/output split as junie-guardian-adapter.js: Junie's PreToolUse
 * input already matches {tool_name, tool_input: {command}}, so the shared
 * pre-bash-crusher-rewrite.js rewrite decision applies unchanged -- only its
 * output needs translating into Junie's flat {decision, updatedInput}
 * envelope (confirmed against junie.jetbrains.com/docs/junie-cli-hooks.html),
 * instead of Claude Code's hookSpecificOutput wrapper. Uses
 * computeCrushedCommand (shared with cursor-crusher-adapter.js) for the
 * actual rewrite decision, rather than each host reimplementing its own
 * JSON.parse(run(JSON.stringify(...))) wrapper (cubic-dev-ai finding, PR
 * #1081).
 *
 * Fail-open throughout: the Crusher is never a security boundary (unlike
 * junie-guardian-adapter.js), so any error or ambiguity here just means the
 * original command runs unmodified.
 */

'use strict';

const { computeCrushedCommand } = require('./pre-bash-crusher-rewrite');
const { readAdapterStdinJson } = require('../lib/adapter-stdin-json');

// Returns the rewritten command string, or null when nothing should change.
function computeRewrittenCommand(event) {
  const command = event && typeof event === 'object' ? event.tool_input?.command : undefined;
  return command ? computeCrushedCommand(command) : null;
}

function respond(payload) {
  // Sets exitCode and lets Node drain stdout naturally instead of forcing
  // process.exit() right after write(): on POSIX, stdout writes to a pipe
  // are asynchronous, so a forced exit can race the write and truncate the
  // response before Junie reads it (cubic-dev-ai finding, PR #1081).
  process.exitCode = 0;
  process.stdout.write(JSON.stringify(payload));
}

function main() {
  readAdapterStdinJson(({ ok, truncated, value }) => {
    if (truncated || !ok) {
      respond({ decision: 'allow' });
      return;
    }

    const rewritten = computeRewrittenCommand(value);
    if (rewritten) {
      respond({ decision: 'allow', updatedInput: { ...value.tool_input, command: rewritten } });
      return;
    }

    respond({ decision: 'allow' });
  });
}

if (require.main === module) {
  main();
}

module.exports = { computeRewrittenCommand };
