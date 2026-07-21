'use strict';

// Wires the GateGuard fact-forcing gate into VS Code's Copilot agent hooks
// (Preview). VS Code documents its hooks.json as the exact same shape Claude
// Code uses -- {"hooks": {"PreToolUse": [{"matcher": ..., "hooks": [...]}]}}
// -- and explicitly lists it as one of the formats it reads for
// compatibility (see https://code.visualstudio.com/docs/agent-customization/hooks).
// That means the generic, destination-path-driven merge helpers already
// built for Claude's settings.json apply unchanged here; this module only
// supplies the VS Code-specific file location and reuses them.
//
// VS Code's documented user-level hook discovery path is `~/.copilot/hooks`,
// which is a different root than where copilot-home.js scaffolds skill
// content (~/.github). The GateGuard script itself is still deployed under
// the adapter's own root (~/.github/scripts/hooks/gateguard-fact-force.js)
// via the normal module path flow; this file's hooks.json merge just points
// its "command" at that already-installed script.

const path = require('node:path');

const {
  createGateGuardHookMergeOperationForDestination,
  resolveGateGuardHookScriptDestination,
  createCrusherHookMergeOperationForDestination,
  resolveCrusherHookScriptDestination,
} = require('./claude-settings-hooks');

function resolveCopilotHooksFilePath(homeDir) {
  return path.join(homeDir, '.copilot', 'hooks', 'hooks.json');
}

function createPreToolUseGateGuardHookMergeOperation(targetRoot, homeDir, matcher) {
  return createGateGuardHookMergeOperationForDestination(
    resolveCopilotHooksFilePath(homeDir),
    resolveGateGuardHookScriptDestination(targetRoot),
    matcher
  );
}

// Token Crusher: VS Code's Copilot hooks read the same hooks.json schema, so the
// crusher hook (installed under the adapter's own ~/.github root) is registered
// at ~/.copilot/hooks/hooks.json just like the gate.
function createPreToolUseCrusherHookMergeOperation(targetRoot, homeDir, matcher) {
  return createCrusherHookMergeOperationForDestination(
    resolveCopilotHooksFilePath(homeDir),
    resolveCrusherHookScriptDestination(targetRoot),
    matcher
  );
}

module.exports = {
  createPreToolUseGateGuardHookMergeOperation,
  createPreToolUseCrusherHookMergeOperation,
  resolveCopilotHooksFilePath,
};
