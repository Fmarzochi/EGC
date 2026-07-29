#!/usr/bin/env node
/**
 * Cursor Agent Hooks adapter for the Token Crusher.
 *
 * Cursor's beforeShellExecution event (where cursor-guardian-adapter.js
 * runs) only returns a permission decision -- it cannot rewrite the
 * command (confirmed against https://cursor.com/docs/agent/hooks: the
 * response schema for that event is {permission, user_message,
 * agent_message}, nothing else). The generic preToolUse event fires for
 * every tool call (Shell, Read, Write, MCP, Task, ...) and its response
 * DOES support `updated_input`, which replaces the tool's parameters
 * before it runs -- the same mechanism Claude Code, Codex, Trae, Qwen
 * Code and Junie CLI already use for the Crusher. This adapter registers
 * on preToolUse, ignores every tool_name other than "Shell", and reuses
 * the shared crusher rewrite decision (pre-bash-crusher-rewrite) to
 * route a crushable command through `egc run` before Cursor executes it.
 *
 * Fail-open throughout: Crusher is a performance optimization, never a
 * security boundary (unlike cursor-guardian-adapter.js), so any error or
 * ambiguity here just means the original command runs unmodified.
 */

'use strict';

const { run: runCrusherRewrite } = require('./pre-bash-crusher-rewrite');
const { readAdapterStdinJson } = require('../lib/adapter-stdin-json');

// Returns the rewritten tool_input object, or null when nothing should
// change (wrong tool, no command, rewrite decided against it, or error).
function computeUpdatedInput(event) {
  if (!event || typeof event !== 'object' || event.tool_name !== 'Shell') {
    return null;
  }
  const command = event.tool_input?.command;
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

  if (typeof rewritten !== 'string' || rewritten === command) {
    return null;
  }

  return { ...event.tool_input, command: rewritten };
}

function respond(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

function main() {
  readAdapterStdinJson(({ ok, truncated, value }) => {
    if (truncated || !ok) {
      respond({ permission: 'allow' });
      return;
    }

    const updatedInput = computeUpdatedInput(value);
    if (updatedInput) {
      respond({ permission: 'allow', updated_input: updatedInput });
      return;
    }

    respond({ permission: 'allow' });
  });
}

if (require.main === module) {
  main();
}

module.exports = { computeUpdatedInput };
