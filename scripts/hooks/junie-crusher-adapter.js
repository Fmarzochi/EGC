#!/usr/bin/env node
/**
 * Junie CLI adapter for the Token Crusher.
 *
 * Same input/output split as junie-guardian-adapter.js: Junie's PreToolUse
 * input already matches {tool_name, tool_input: {command}}, so the shared
 * pre-bash-crusher-rewrite.js rewrite decision applies unchanged -- only its
 * output needs translating into Junie's flat {decision, updatedInput}
 * envelope (confirmed against junie.jetbrains.com/docs/junie-cli-hooks.html),
 * instead of Claude Code's hookSpecificOutput wrapper.
 *
 * Fail-open throughout: the Crusher is never a security boundary (unlike
 * junie-guardian-adapter.js), so any error or ambiguity here just means the
 * original command runs unmodified.
 */

'use strict';

const { run: runCrusherRewrite } = require('./pre-bash-crusher-rewrite');
const { readAdapterStdinJson } = require('../lib/adapter-stdin-json');

// Returns the rewritten command string, or null when nothing should change.
function computeRewrittenCommand(event) {
  const command = event && typeof event === 'object' ? event.tool_input?.command : undefined;
  if (!command) {
    return null;
  }

  let rewritten;
  try {
    const result = JSON.parse(runCrusherRewrite(JSON.stringify({ tool_input: { command } })));
    rewritten = result?.tool_input?.command;
  } catch {
    return null;
  }

  return typeof rewritten === 'string' && rewritten !== command ? rewritten : null;
}

function respond(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
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
