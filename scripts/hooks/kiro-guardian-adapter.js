#!/usr/bin/env node
/**
 * Kiro CLI agent-hooks adapter for the EGC Guardian command validator.
 *
 * Kiro's preToolUse hook (docs: https://kiro.dev/docs/cli/hooks/) uses a
 * different wire contract than Claude Code's PreToolUse hook: stdin JSON is
 * {hook_event_name, cwd, session_id, tool_name, tool_input} instead of
 * {tool_name, tool_input}, though the tool_name/tool_input fields
 * themselves are named and shaped the same way. Blocking is exit code 2
 * with the reason on stderr -- the exact contract
 * pre-bash-guardian-validate.js's run() already returns, so this
 * translation only needs to build the input shape, no output envelope.
 *
 * tool_input's exact field for the execute_bash command string is
 * undocumented publicly (verified against kiro.dev/docs/cli/hooks/,
 * .../reference/built-in-tools/, and .../custom-agents/configuration-
 * reference/ -- none give the schema). This reads tool_input.command by
 * convention, matching every other host wired today (Claude Code, Cursor,
 * Windsurf, Codex all use that field name for their Bash/shell tool). If
 * that guess is wrong, buildGuardianInput returns null and the hook fails
 * open (allow) rather than crashing or blocking everything.
 *
 * Registered only on the execute_bash matcher (not fs_read/fs_write) --
 * the Guardian validates shell commands, not file operations.
 */

'use strict';

const { run } = require('./pre-bash-guardian-validate');
const { readAdapterStdinJson } = require('../lib/adapter-stdin-json');

const BASH_TOOL_NAMES = new Set(['execute_bash', 'shell', 'execute_cmd']);

function buildGuardianInput(kiroEvent) {
  if (!kiroEvent || typeof kiroEvent !== 'object') {
    return null;
  }
  if (!BASH_TOOL_NAMES.has(kiroEvent.tool_name)) {
    return null;
  }
  const command = kiroEvent.tool_input?.command;
  if (!command || typeof command !== 'string') {
    return null;
  }
  const input = { tool_name: 'Bash', tool_input: { command } };
  if (typeof kiroEvent.cwd === 'string') {
    input.cwd = kiroEvent.cwd;
  }
  return input;
}

function main() {
  readAdapterStdinJson(({ ok, truncated, value }) => {
    if (!ok) {
      // A parse failure caused by hitting the size cap is not the same as
      // ordinary malformed input: an attacker can pad a command past the
      // stdin cap specifically to land here and fail open. Only genuinely
      // malformed (non-truncated) input gets the fail-open policy the other
      // adapters use; a truncated payload is unanalyzable and fails closed.
      if (truncated) {
        process.stderr.write(
          'EGC Guardian BLOCKED this command: the event payload exceeded the size ' +
          'this validator can safely read, so it could not be parsed or validated. ' +
          'Simplify the command.\n'
        );
        process.exit(2);
      }
      process.exit(0);
    }

    const guardianInput = buildGuardianInput(value);
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
