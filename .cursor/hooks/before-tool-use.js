#!/usr/bin/env node
/**
 * preToolUse hook: routes Cursor's Write/Shell tool calls through the
 * shared GateGuard fact-forcing gate (scripts/hooks/gateguard-fact-force.js),
 * the same investigation gate Claude Code and Gemini CLI already enforce.
 *
 * Cursor's preToolUse input already matches gateguard-fact-force.js's
 * expected shape (tool_name/tool_input over stdin), so this file's only job
 * is calling the shared gate in-process (mirroring how bash-hook-dispatcher.js
 * and Gemini's run-with-flags.js already require() and call run() directly,
 * rather than re-implementing the gate logic here) and translating its
 * Claude-shaped deny response into Cursor's `permission` output contract.
 * See adapter.js for the translation helpers and why they're needed.
 */
const path = require('path');
const {
  readStdin,
  hookEnabled,
  GATEGUARD_EDIT_WRITE_HOOK_ID,
  GATEGUARD_BASH_HOOK_ID,
  buildGateGuardInput,
  translateGateGuardResult,
} = require('./adapter');

const ALLOW = { permission: 'allow' };

function allowAndExit() {
  process.stdout.write(JSON.stringify(ALLOW));
  process.exit(0);
}

readStdin()
  .then(raw => {
    let cursorInput;
    try {
      cursorInput = JSON.parse(raw || '{}');
    } catch (_) {
      return allowAndExit();
    }

    const gateInput = buildGateGuardInput(cursorInput);
    const isBash = gateInput.tool_name === 'Bash';
    const isEditWrite = gateInput.tool_name === 'Edit' || gateInput.tool_name === 'Write' || gateInput.tool_name === 'MultiEdit';

    if (!isBash && !isEditWrite) {
      return allowAndExit();
    }

    const hookId = isBash ? GATEGUARD_BASH_HOOK_ID : GATEGUARD_EDIT_WRITE_HOOK_ID;
    if (!hookEnabled(hookId, ['standard', 'strict'])) {
      return allowAndExit();
    }

    let result;
    try {
      const gateGuard = require(path.join(__dirname, '..', '..', 'scripts', 'hooks', 'gateguard-fact-force.js'));
      result = gateGuard.run(gateInput);
    } catch (_) {
      return allowAndExit();
    }

    process.stdout.write(JSON.stringify(translateGateGuardResult(result)));
    process.exit(0);
  })
  .catch(() => allowAndExit());
