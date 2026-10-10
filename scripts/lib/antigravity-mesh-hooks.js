'use strict';

// The session-mesh wake signal as the egc-mesh-notice named hook in
// Antigravity's own hooks.json format (antigravity-named-hooks.js).
// Antigravity has no UserPromptSubmit: its events are PreToolUse,
// PostToolUse, PreInvocation, PostInvocation and Stop, and a PreInvocation
// hook may answer with steps to inject before the model is called
// (antigravity.google/docs/hooks, read 2026-10-10). So the notice rides
// PreInvocation, through antigravity-mesh-notice-adapter.js, which injects
// one ephemeral message when the bus store moved and nothing otherwise. The
// group carries no matcher: Antigravity ignores it on this event.

const { buildHookCommand, createAntigravityNamedHook } = require('./antigravity-named-hooks');

const HOOK_NAME = 'egc-mesh-notice';
const ANTIGRAVITY_MESH_HOOK_TAG = 'antigravity:egc-mesh-notice';
const HOOK_TIMEOUT_SECONDS = 10;
const ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/antigravity-mesh-notice-adapter.js';

function meshNoticeHookDefinition(adapterScriptPath) {
  return {
    PreInvocation: [
      { hooks: [{ type: 'command', command: buildHookCommand(adapterScriptPath), timeout: HOOK_TIMEOUT_SECONDS }] },
    ],
  };
}

const meshHook = createAntigravityNamedHook({
  hookName: HOOK_NAME,
  hookTag: ANTIGRAVITY_MESH_HOOK_TAG,
  adapterSourceRelativePath: ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  definition: meshNoticeHookDefinition,
});

module.exports = {
  ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  ANTIGRAVITY_MESH_HOOK_TAG,
  HOOK_NAME,
  applyAntigravityMeshHookToFile: meshHook.applyToFile,
  inspectAntigravityMeshHookFile: meshHook.inspectFile,
  meshNoticeHookDefinition,
  removeAntigravityMeshHookFromFile: meshHook.removeFromFile,
  resolveAdapterScriptDestination: meshHook.resolveAdapterScriptDestination,
};
