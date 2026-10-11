'use strict';

// The GateGuard fact-forcing gate as the egc-gateguard named hook in
// Antigravity's own hooks.json format (antigravity-named-hooks.js): the same
// PreToolUse group as the Guardian, on Antigravity's shell and file-write
// tools, running antigravity-gateguard-adapter.js, which answers deny with
// the facts the gate asks for, or ask to leave the call to the person's
// permission settings.

const { buildHookCommand, createAntigravityNamedHook } = require('./antigravity-named-hooks');
const { GUARDED_TOOLS_MATCHER } = require('./antigravity-guardian-hooks');

const HOOK_NAME = 'egc-gateguard';
const ANTIGRAVITY_GATEGUARD_HOOK_TAG = 'antigravity:egc-gateguard';
const HOOK_TIMEOUT_SECONDS = 30;
const ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/antigravity-gateguard-adapter.js';

function gateguardHookDefinition(adapterScriptPath) {
  return {
    PreToolUse: [
      {
        matcher: GUARDED_TOOLS_MATCHER,
        hooks: [{ type: 'command', command: buildHookCommand(adapterScriptPath), timeout: HOOK_TIMEOUT_SECONDS }],
      },
    ],
  };
}

const gateguardHook = createAntigravityNamedHook({
  hookName: HOOK_NAME,
  hookTag: ANTIGRAVITY_GATEGUARD_HOOK_TAG,
  adapterSourceRelativePath: ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  definition: gateguardHookDefinition,
});

module.exports = {
  ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  ANTIGRAVITY_GATEGUARD_HOOK_TAG,
  HOOK_NAME,
  applyAntigravityGateGuardHookToFile: gateguardHook.applyToFile,
  gateguardHookDefinition,
  inspectAntigravityGateGuardHookFile: gateguardHook.inspectFile,
  removeAntigravityGateGuardHookFromFile: gateguardHook.removeFromFile,
  resolveAdapterScriptDestination: gateguardHook.resolveAdapterScriptDestination,
};
