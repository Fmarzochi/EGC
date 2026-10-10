'use strict';

// The EGC Guardian as the egc-guardian named hook in Antigravity's own
// hooks.json format (antigravity-named-hooks.js): its PreToolUse group
// matches Antigravity's shell and file-write tools and runs
// antigravity-guardian-adapter.js, which answers in Antigravity's
// {decision, reason} contract.

const {
  buildHookCommand,
  createAntigravityNamedHook,
  resolveGlobalHooksJsonPath,
  resolveProjectHooksJsonPath,
} = require('./antigravity-named-hooks');

const HOOK_NAME = 'egc-guardian';
// Dispatch key for this operation in claude-settings-hooks.js's handler
// table; distinct from every Claude event name the table also holds.
const ANTIGRAVITY_GUARDIAN_HOOK_TAG = 'antigravity:egc-guardian';
const GUARDED_TOOLS_MATCHER = 'run_command|write_to_file|replace_file_content|multi_replace_file_content';
const HOOK_TIMEOUT_SECONDS = 30;
const ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/antigravity-guardian-adapter.js';

function guardianHookDefinition(adapterScriptPath) {
  return {
    PreToolUse: [
      {
        matcher: GUARDED_TOOLS_MATCHER,
        hooks: [{ type: 'command', command: buildHookCommand(adapterScriptPath), timeout: HOOK_TIMEOUT_SECONDS }],
      },
    ],
  };
}

const guardianHook = createAntigravityNamedHook({
  hookName: HOOK_NAME,
  hookTag: ANTIGRAVITY_GUARDIAN_HOOK_TAG,
  adapterSourceRelativePath: ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  definition: guardianHookDefinition,
});

module.exports = {
  ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  ANTIGRAVITY_GUARDIAN_HOOK_TAG,
  GUARDED_TOOLS_MATCHER,
  HOOK_NAME,
  applyAntigravityGuardianHookToFile: guardianHook.applyToFile,
  guardianHookDefinition,
  inspectAntigravityGuardianHookFile: guardianHook.inspectFile,
  removeAntigravityGuardianHookFromFile: guardianHook.removeFromFile,
  resolveAdapterScriptDestination: guardianHook.resolveAdapterScriptDestination,
  resolveGlobalHooksJsonPath,
  resolveProjectHooksJsonPath,
};
