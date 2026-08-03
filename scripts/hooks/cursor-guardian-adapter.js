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
const { runJsonEnvelopeGuardianAdapter } = require('../lib/adapter-stdin-json');

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

function respond(blocked, message) {
  // process.exitCode (not process.exit()) so Node drains stdout naturally:
  // on POSIX a forced exit can race the pipe write and truncate the
  // response before Cursor reads it (same cubic-dev-ai finding already
  // applied to the Cline/Junie translation adapters, PR #1081 -- this one
  // was still on the older, race-prone process.exit() pattern until the
  // EGC-539 audit's Finding 3 consolidation).
  const permission = blocked ? 'deny' : 'allow';
  const payload = message ? { permission, user_message: message, agent_message: message } : { permission };
  process.exitCode = blocked ? 2 : 0;
  process.stdout.write(JSON.stringify(payload));
}

function main() {
  runJsonEnvelopeGuardianAdapter(buildGuardianInput, run, respond);
}

if (require.main === module) {
  main();
}

module.exports = { buildGuardianInput };
