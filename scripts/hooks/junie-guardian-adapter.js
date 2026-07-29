#!/usr/bin/env node
/**
 * Junie CLI adapter for the EGC Guardian command validator.
 *
 * Junie's PreToolUse hook input already matches Claude Code's own shape
 * ({tool_name, tool_input: {command}}) -- confirmed against
 * junie.jetbrains.com/docs/junie-cli-hooks.html -- so no input remapping is
 * needed, unlike Cursor/Windsurf. Only the OUTPUT envelope differs: Junie
 * expects a FLAT {decision, reason, updatedInput} object on stdout, not
 * Claude Code's {hookSpecificOutput: {permissionDecision, updatedInput}}.
 * pre-bash-guardian-validate.js's own run() already returns {exitCode,
 * stderr} directly, so this only needs to translate that into Junie's
 * decision vocabulary ("allow" | "deny") plus exit code 2 to block
 * regardless of stdout, per the doc's documented alternative contract.
 */

'use strict';

const { run } = require('./pre-bash-guardian-validate');
const { readAdapterStdinJson } = require('../lib/adapter-stdin-json');

function respond(decision, reason) {
  // Sets exitCode and lets Node drain stdout naturally instead of forcing
  // process.exit() right after write(): on POSIX, stdout writes to a pipe
  // (which is what a hook subprocess always has) are asynchronous, so a
  // forced exit can race the write and truncate the response before Junie
  // reads it (cubic-dev-ai finding, PR #1081).
  const payload = reason ? { decision, reason } : { decision };
  process.exitCode = decision === 'deny' ? 2 : 0;
  process.stdout.write(JSON.stringify(payload));
}

function main() {
  readAdapterStdinJson(({ ok, truncated, value }) => {
    // Same fail-closed-on-truncation guard as the Cursor/Windsurf/Kiro
    // adapters (cubic-dev-ai finding, PR #1073/#1074): a capped-length
    // prefix can still happen to be syntactically valid JSON, so truncation
    // is checked unconditionally, before `ok`.
    if (truncated) {
      respond('deny', 'EGC Guardian BLOCKED this command: the event payload exceeded the size ' +
        'this validator can safely read, so it could not be parsed or validated. ' +
        'Simplify the command.');
      return;
    }
    if (!ok) {
      respond('allow');
      return;
    }

    const event = value;
    const command = event && typeof event === 'object' ? event.tool_input?.command : undefined;
    if (!command) {
      respond('allow');
      return;
    }

    const guardianInput = { tool_name: 'Bash', tool_input: { command } };
    if (event && typeof event.cwd === 'string') {
      guardianInput.cwd = event.cwd;
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

module.exports = {};
