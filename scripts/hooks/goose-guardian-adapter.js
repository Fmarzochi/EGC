#!/usr/bin/env node
/**
 * Goose (block/goose, now hosted at aaif-goose/goose) plugin-hook adapter
 * for the EGC Guardian command validator.
 *
 * Goose's PreToolUse hook (docs/guides/context-engineering/hooks.md, and
 * the shipped emit_blocking()/HookDecision code in crates/goose/src/hooks/
 * mod.rs, merged 2026-05-19 in PR #9304) delivers the event as JSON on
 * stdin -- {event, session_id, matcher_context, tool_name, tool_input:
 * {command}, working_dir} -- and blocks via exit code 2 (reason on
 * stderr) or a {"decision":"block","reason":"..."} JSON line on stdout;
 * this adapter always uses the exit-code form since
 * pre-bash-guardian-validate.js's run() already returns exactly that
 * contract. Goose's own docs describe this hook format as following
 * Claude Code's convention -- confirmed structurally identical
 * (matcher/nested-hooks-array JSON shape), which is why the *installer*
 * side (goose-home.js) reuses claude-settings-hooks.js's own
 * destination-driven merge builders instead of a bespoke one, the same
 * way Junie and Trae already do for their own config files.
 *
 * A misbehaving hook (crash, timeout, non-2 non-zero exit) is logged and
 * treated as Allow by Goose itself -- documented fail-open behavior on
 * Goose's side, not something this adapter can change; it only controls
 * what happens when it runs to completion normally.
 *
 * Registered only on the developer__shell matcher (Goose's actual shell
 * tool name, confirmed against its own hooks.json example) -- the
 * Guardian validates shell commands, not file operations.
 */

'use strict';

const { run } = require('./pre-bash-guardian-validate');
const { runPlainExitCodeGuardianAdapter } = require('../lib/adapter-stdin-json');

function buildGuardianInput(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }
  if (event.tool_name !== 'developer__shell') {
    return null;
  }
  const command = event.tool_input?.command;
  if (!command || typeof command !== 'string') {
    return null;
  }
  const input = { tool_name: 'Bash', tool_input: { command } };
  if (typeof event.working_dir === 'string') {
    input.cwd = event.working_dir;
  }
  return input;
}

function main() {
  runPlainExitCodeGuardianAdapter(buildGuardianInput, run);
}

if (require.main === module) {
  main();
}

module.exports = { buildGuardianInput };
