#!/usr/bin/env node
/**
 * Cursor Agent Hooks adapter for the EGC Guardian command validator.
 *
 * Cursor's beforeShellExecution hook uses a different wire contract than
 * Claude Code's PreToolUse hook (see windsurf-guardian-adapter.js for the
 * same distinction this file mirrors): {command, cwd, ...} on stdin instead
 * of {tool_name, tool_input}, and a JSON {permission, user_message,
 * agent_message} response on stdout in addition to the block/allow exit
 * code (docs: https://cursor.com/docs/agent/hooks -- exit code 2 blocks
 * regardless of stdout, other codes fail open).
 *
 * pre-bash-guardian-validate.js's own run() already returns {exitCode,
 * stderr} directly (no JSON envelope to unwrap), so unlike the GateGuard
 * adapter this translation only needs to build its input shape and relay
 * its output as-is, plus the permission JSON Cursor's contract expects.
 */

'use strict';

const { run } = require('./pre-bash-guardian-validate');

function buildGuardianInput(cursorEvent) {
  const command = cursorEvent.command || '';
  if (!command) {
    return null;
  }
  // cwd matters here (unlike for GateGuard's fact-forcing gate): the
  // Guardian resolves relative protected paths (e.g. `cat .ssh/id_rsa`)
  // against it. Without it, those checks fall back to this adapter
  // process's own cwd instead of the directory Cursor actually runs the
  // command in.
  const input = { tool_name: 'Bash', tool_input: { command } };
  if (typeof cursorEvent.cwd === 'string') {
    input.cwd = cursorEvent.cwd;
  }
  return input;
}

function main() {
  const MAX_STDIN = 1024 * 1024;
  let raw = '';
  let truncated = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      raw += chunk.substring(0, MAX_STDIN - raw.length);
    }
    if (raw.length >= MAX_STDIN) {
      truncated = true;
    }
  });
  process.stdin.on('end', () => {
    let cursorEvent;
    try {
      cursorEvent = JSON.parse(raw);
    } catch {
      // A parse failure caused by hitting the size cap is not the same as
      // ordinary malformed input: an attacker can pad a command past
      // MAX_STDIN specifically to land here and fail open. Only genuinely
      // malformed (non-truncated) input gets the fail-open policy the other
      // adapters use; a truncated payload is unanalyzable and fails closed.
      if (truncated) {
        const message = 'EGC Guardian BLOCKED this command: the event payload exceeded the size ' +
          'this validator can safely read, so it could not be parsed or validated. ' +
          'Simplify the command.';
        process.stdout.write(JSON.stringify({ permission: 'deny', user_message: message, agent_message: message }));
        process.exit(2);
      }
      process.stdout.write(JSON.stringify({ permission: 'allow' }));
      process.exit(0);
    }

    const guardianInput = buildGuardianInput(cursorEvent);
    if (!guardianInput) {
      process.stdout.write(JSON.stringify({ permission: 'allow' }));
      process.exit(0);
    }

    const result = run(guardianInput);
    if (result.exitCode === 2) {
      const reason = result.stderr || 'Blocked by the EGC Guardian.';
      process.stdout.write(JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason }));
      process.exit(2);
    }

    process.stdout.write(JSON.stringify({ permission: 'allow' }));
    process.exit(0);
  });
}

if (require.main === module) {
  main();
}

module.exports = { buildGuardianInput };
