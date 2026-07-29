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
const { readAdapterStdinJson } = require('../lib/adapter-stdin-json');

function buildGuardianInput(cursorEvent) {
  if (!cursorEvent || typeof cursorEvent !== 'object') {
    return null;
  }
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

function respond(permission, message) {
  const payload = message ? { permission, user_message: message, agent_message: message } : { permission };
  process.stdout.write(JSON.stringify(payload));
  process.exit(permission === 'deny' ? 2 : 0);
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
        respond('deny', 'EGC Guardian BLOCKED this command: the event payload exceeded the size ' +
          'this validator can safely read, so it could not be parsed or validated. ' +
          'Simplify the command.');
        return;
      }
      respond('allow');
      return;
    }

    const guardianInput = buildGuardianInput(value);
    if (!guardianInput) {
      respond('allow');
      return;
    }

    const result = run(guardianInput);
    if (result.exitCode === 2) {
      respond('deny', result.stderr || 'Blocked by the EGC Guardian.');
      return;
    }

    respond('allow');
  });
}

if (require.main === module) {
  main();
}

module.exports = { buildGuardianInput };
