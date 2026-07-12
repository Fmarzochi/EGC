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

const path = require('path');

const {
  GATEGUARD_HOOK_MODULE_ID,
  GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  HOOK_OPERATION_KIND,
  PRE_TOOL_USE_EVENT,
  resolveGateGuardHookScriptDestination,
} = require('./claude-settings-hooks');

function resolveCopilotHooksFilePath(homeDir) {
  return path.join(homeDir, '.copilot', 'hooks', 'hooks.json');
}

function createPreToolUseGateGuardHookMergeOperation(targetRoot, homeDir, matcher) {
  const hookScriptPath = resolveGateGuardHookScriptDestination(targetRoot);
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: GATEGUARD_HOOK_MODULE_ID,
    sourceRelativePath: GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: resolveCopilotHooksFilePath(homeDir),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_TOOL_USE_EVENT,
    hookMatcher: matcher,
    hookScriptPath,
  };
}

module.exports = {
  createPreToolUseGateGuardHookMergeOperation,
  resolveCopilotHooksFilePath,
};
