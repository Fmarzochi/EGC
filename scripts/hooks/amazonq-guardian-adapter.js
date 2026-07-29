#!/usr/bin/env node
/**
 * Amazon Q Developer CLI custom-agent adapter for the EGC Guardian command
 * validator.
 *
 * Amazon Q's preToolUse hook (docs: aws/amazon-q-developer-cli's own
 * docs/hooks.md and docs/agent-format.md) delivers the event as JSON on
 * stdin -- {hook_event_name, cwd, tool_name, tool_input: {command}} -- and
 * blocks via exit code 2 with the reason on stderr ("2: Block tool
 * execution, return STDERR to LLM"), the exact same wire contract Kiro's
 * CLI already uses (confirmed against both tools' own docs independently,
 * not assumed from the similarity). No rewrite capability is documented,
 * so this only ever allows or blocks -- Token Crusher stays out of scope
 * here, same as Kiro/Windsurf/Cline.
 *
 * Registered only on the execute_bash matcher via the agent config's
 * preToolUse entry (see amazonq-guardian-hooks.js) -- the Guardian
 * validates shell commands, not file operations.
 */

'use strict';

const { run } = require('./pre-bash-guardian-validate');
const { runPlainExitCodeGuardianAdapter } = require('../lib/adapter-stdin-json');

function buildGuardianInput(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }
  if (event.tool_name !== 'execute_bash') {
    return null;
  }
  const command = event.tool_input?.command;
  if (!command || typeof command !== 'string') {
    return null;
  }
  const input = { tool_name: 'Bash', tool_input: { command } };
  if (typeof event.cwd === 'string') {
    input.cwd = event.cwd;
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
