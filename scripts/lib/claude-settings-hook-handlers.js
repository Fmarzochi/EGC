'use strict';

// Dispatch table from an operation hookEvent to its apply, remove and inspect handlers.
// Part of the claude-settings-hooks.js split; that file re-exports the public surface.

const {
  PRE_RUN_COMMAND_EVENT: WINDSURF_PRE_RUN_COMMAND_EVENT,
  PRE_WRITE_CODE_EVENT: WINDSURF_PRE_WRITE_CODE_EVENT,
  applyWindsurfGateGuardHookToFile,
  inspectWindsurfGateGuardHookFile,
  removeWindsurfGateGuardHookFromFile,
} = require('./windsurf-gateguard-hooks');
const {
  BEFORE_SHELL_EXECUTION_EVENT: CURSOR_BEFORE_SHELL_EXECUTION_EVENT,
  applyCursorGuardianHookToFile,
  inspectCursorGuardianHookFile,
  removeCursorGuardianHookFromFile,
} = require('./cursor-guardian-hooks');
const {
  CRUSHER_HOOK_DISPATCH_EVENT: CURSOR_CRUSHER_HOOK_DISPATCH_EVENT,
  applyCursorCrusherHookToFile,
  inspectCursorCrusherHookFile,
  removeCursorCrusherHookFromFile,
} = require('./cursor-crusher-hooks');
const {
  PRE_TOOL_USE_EVENT: KIRO_PRE_TOOL_USE_EVENT,
  applyKiroGuardianHookToFile,
  inspectKiroGuardianHookFile,
  removeKiroGuardianHookFromFile,
} = require('./kiro-guardian-hooks');
const {
  OPERATION_DISPATCH_TAG: KIRO_MESH_HOOK_FILE_TAG,
  applyKiroMeshHookToFile,
  inspectKiroMeshHookFile,
  removeKiroMeshHookFromFile,
} = require('./kiro-mesh-hooks');
const {
  OPERATION_DISPATCH_TAG: KIRO_V3_GUARDIAN_HOOK_FILE_TAG,
  applyKiroV3GuardianHookToFile,
  inspectKiroV3GuardianHookFile,
  removeKiroV3GuardianHookFromFile,
} = require('./kiro-v3-guardian-hooks');
const {
  OPERATION_DISPATCH_TAG: GROK_GUARDIAN_HOOK_FILE_TAG,
  applyGrokGuardianHookToFile,
  inspectGrokGuardianHookFile,
  removeGrokGuardianHookFromFile,
} = require('./grok-hooks');
const {
  OPERATION_DISPATCH_TAG: AMAZONQ_OPERATION_DISPATCH_TAG,
  applyAmazonQGuardianHookToFile,
  inspectAmazonQGuardianHookFile,
  removeAmazonQGuardianHookFromFile,
} = require('./amazonq-guardian-hooks');
const {
  PRE_TOOL_USE_EVENT: OPENHANDS_PRE_TOOL_USE_EVENT,
  applyOpenHandsGuardianHookToFile,
  inspectOpenHandsGuardianHookFile,
  removeOpenHandsGuardianHookFromFile,
} = require('./openhands-guardian-hooks');
const {
  ANTIGRAVITY_GUARDIAN_HOOK_TAG,
  applyAntigravityGuardianHookToFile,
  inspectAntigravityGuardianHookFile,
  removeAntigravityGuardianHookFromFile,
} = require('./antigravity-guardian-hooks');
const {
  ANTIGRAVITY_GATEGUARD_HOOK_TAG,
  applyAntigravityGateGuardHookToFile,
  inspectAntigravityGateGuardHookFile,
  removeAntigravityGateGuardHookFromFile,
} = require('./antigravity-gateguard-hooks');
const {
  ANTIGRAVITY_MESH_HOOK_TAG,
  applyAntigravityMeshHookToFile,
  inspectAntigravityMeshHookFile,
  removeAntigravityMeshHookFromFile,
} = require('./antigravity-mesh-hooks');
const {
  ROOCODE_DENYLIST_TAG,
  applyRoocodeDenylistToFile,
  inspectRoocodeDenylistFile,
  removeRoocodeDenylistFromFile,
} = require('./vscode-denied-commands');
const {
  CRUSH_PRE_TOOL_USE_EVENT,
  applyCrushHookToFile,
  inspectCrushHookFile,
  removeCrushHookFromFile,
} = require('./crush-settings-hooks');
const {
  KIMI_HOOK_OPERATION_HANDLERS,
  KIMI_PRE_TOOL_EVENT,
} = require('./kimi-hooks-toml');
const {
  VIBE_HOOK_OPERATION_HANDLERS,
  VIBE_PRE_TOOL_EVENT,
} = require('./vibe-hooks-toml');
const {
  STOP_EVENT,
  USER_PROMPT_SUBMIT_EVENT,
  PRE_TOOL_USE_EVENT,
  PRE_COMPACT_EVENT,
  POST_COMPACT_EVENT,
  applyHookEntryToFile,
  removeHookEntryFromFile,
  inspectHookEntryFile,
} = require('./claude-settings-hook-core');
const {
  applySessionStartHookToFile,
  removeSessionStartHookFromFile,
  inspectSessionStartHookFile,
  applyStopHookToFile,
  removeStopHookFromFile,
  inspectStopHookFile,
  applyIntuitionHookToFile,
  removeIntuitionHookFromFile,
  inspectIntuitionHookFile,
} = require('./claude-settings-hook-events');
const {
  applyPreCompactHookToFile,
  removePreCompactHookFromFile,
  inspectPreCompactHookFile,
} = require('./claude-settings-compact-hooks');

// Devin Desktop's two managed events (pre_write_code, pre_run_command) both go
// through the same flat-hooks.json helpers, just forwarding whichever of the
// two the operation actually carries -- one handler trio, two table keys,
// equivalent to the old `MANAGED_WINDSURF_HOOK_EVENTS.has(...)` Set check.
const WINDSURF_HOOK_OPERATION_HANDLERS = {
  apply: operation => applyWindsurfGateGuardHookToFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
  remove: operation => removeWindsurfGateGuardHookFromFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
  inspect: operation => inspectWindsurfGateGuardHookFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
};

// Single source of truth for "given this operation's hookEvent, which
// apply/remove/inspect functions handle it". Shared by applyManagedHookOperation
// below, and by install-lifecycle.js's uninstallManagedHookOperation and
// inspectManagedOperation (via resolveHookOperationHandlers) -- previously
// each of those three call sites re-enumerated this same ~11-event chain
// independently, so adding a new host meant remembering to update 2-3 places
// by hand (EGC-539 audit finding). SessionStart is deliberately absent: it is
// the fallback for any hookEvent not listed here, matching every original
// chain's trailing `else` branch (see resolveHookOperationHandlers).
const HOOK_EVENT_OPERATION_HANDLERS = {
  [STOP_EVENT]: {
    apply: operation => applyStopHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeStopHookFromFile(operation.destinationPath, operation.hookScriptPath),
    inspect: operation => inspectStopHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [USER_PROMPT_SUBMIT_EVENT]: {
    apply: operation => applyIntuitionHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeIntuitionHookFromFile(operation.destinationPath, operation.hookScriptPath),
    inspect: operation => inspectIntuitionHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [PRE_TOOL_USE_EVENT]: {
    // Apply/inspect scope to the operation's matcher, since several distinct
    // PreToolUse hooks (Bash dispatcher, write validator, GateGuard, Crusher)
    // share this event under different matchers. Remove does not: a given
    // EGC hook script path is only ever registered once per event regardless
    // of matcher, and removeHookEntry() already strips it from every group.
    apply: operation => applyHookEntryToFile(operation.destinationPath, PRE_TOOL_USE_EVENT, operation.hookScriptPath, { matcher: operation.hookMatcher }),
    remove: operation => removeHookEntryFromFile(operation.destinationPath, PRE_TOOL_USE_EVENT, operation.hookScriptPath),
    inspect: operation => inspectHookEntryFile(operation.destinationPath, PRE_TOOL_USE_EVENT, operation.hookScriptPath, operation.hookMatcher),
  },
  [PRE_COMPACT_EVENT]: {
    apply: operation => applyPreCompactHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removePreCompactHookFromFile(operation.destinationPath, operation.hookScriptPath),
    inspect: operation => inspectPreCompactHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [POST_COMPACT_EVENT]: {
    // PostCompact reuses claude-session-start.js (see
    // createPostCompactHookMergeOperation above) but is still merged/removed/
    // inspected under its own event key via the generic entry helpers, not
    // the SessionStart-specific ones.
    apply: operation => applyHookEntryToFile(operation.destinationPath, POST_COMPACT_EVENT, operation.hookScriptPath),
    remove: operation => removeHookEntryFromFile(operation.destinationPath, POST_COMPACT_EVENT, operation.hookScriptPath),
    inspect: operation => inspectHookEntryFile(operation.destinationPath, POST_COMPACT_EVENT, operation.hookScriptPath),
  },
  [WINDSURF_PRE_WRITE_CODE_EVENT]: WINDSURF_HOOK_OPERATION_HANDLERS,
  [WINDSURF_PRE_RUN_COMMAND_EVENT]: WINDSURF_HOOK_OPERATION_HANDLERS,
  [CURSOR_BEFORE_SHELL_EXECUTION_EVENT]: {
    // Only apply threads seedPath through: it seeds a freshly scaffolded
    // hooks.json on first install and has no meaning for remove/inspect,
    // which only ever read or strip an already-existing entry.
    apply: operation => applyCursorGuardianHookToFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath, { seedPath: operation.seedPath }),
    remove: operation => removeCursorGuardianHookFromFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
    inspect: operation => inspectCursorGuardianHookFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
  },
  [CURSOR_CRUSHER_HOOK_DISPATCH_EVENT]: {
    apply: operation => applyCursorCrusherHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeCursorCrusherHookFromFile(operation.destinationPath, operation.hookScriptPath),
    inspect: operation => inspectCursorCrusherHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [KIRO_PRE_TOOL_USE_EVENT]: {
    apply: operation => applyKiroGuardianHookToFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
    remove: operation => removeKiroGuardianHookFromFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
    inspect: operation => inspectKiroGuardianHookFile(operation.destinationPath, operation.hookEvent, operation.hookScriptPath),
  },
  [GROK_GUARDIAN_HOOK_FILE_TAG]: {
    apply: operation => applyGrokGuardianHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeGrokGuardianHookFromFile(operation.destinationPath),
    inspect: operation => inspectGrokGuardianHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [KIRO_V3_GUARDIAN_HOOK_FILE_TAG]: {
    apply: operation => applyKiroV3GuardianHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeKiroV3GuardianHookFromFile(operation.destinationPath),
    inspect: operation => inspectKiroV3GuardianHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [KIRO_MESH_HOOK_FILE_TAG]: {
    // Whole-file ownership: egc-mesh-notice.json exists solely for this
    // entry, so remove deletes the file and never merges user content.
    apply: operation => applyKiroMeshHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeKiroMeshHookFromFile(operation.destinationPath),
    inspect: operation => inspectKiroMeshHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  // Recorded by installs of the retired Amazon Q adapter (the Guardian
  // entry in .amazonq/cli-agents/egc-guardian.json): nothing plans it any
  // more, and the handlers stay so doctor and uninstall still handle what
  // those installs wrote.
  [AMAZONQ_OPERATION_DISPATCH_TAG]: {
    apply: operation => applyAmazonQGuardianHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeAmazonQGuardianHookFromFile(operation.destinationPath, operation.hookScriptPath),
    inspect: operation => inspectAmazonQGuardianHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [OPENHANDS_PRE_TOOL_USE_EVENT]: {
    apply: operation => applyOpenHandsGuardianHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeOpenHandsGuardianHookFromFile(operation.destinationPath, operation.hookScriptPath),
    inspect: operation => inspectOpenHandsGuardianHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [ANTIGRAVITY_GUARDIAN_HOOK_TAG]: {
    // EGC owns the whole egc-guardian named hook in Antigravity's hooks.json,
    // so remove drops that key whatever script path it points at.
    apply: operation => applyAntigravityGuardianHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeAntigravityGuardianHookFromFile(operation.destinationPath),
    inspect: operation => inspectAntigravityGuardianHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  // The same whole-name ownership for the two other named hooks EGC writes
  // to Antigravity's hooks.json: the GateGuard gate (PreToolUse) and the
  // session-mesh notice (PreInvocation).
  [ANTIGRAVITY_GATEGUARD_HOOK_TAG]: {
    apply: operation => applyAntigravityGateGuardHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeAntigravityGateGuardHookFromFile(operation.destinationPath),
    inspect: operation => inspectAntigravityGateGuardHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  [ANTIGRAVITY_MESH_HOOK_TAG]: {
    apply: operation => applyAntigravityMeshHookToFile(operation.destinationPath, operation.hookScriptPath),
    remove: operation => removeAntigravityMeshHookFromFile(operation.destinationPath),
    inspect: operation => inspectAntigravityMeshHookFile(operation.destinationPath, operation.hookScriptPath),
  },
  // Recorded by installs of the retired Roo Code adapter (roo-cline.deniedCommands
  // seeded into a workspace's .vscode/settings.json): nothing plans it any
  // more, and the handlers stay so doctor, repair and uninstall still handle
  // what those installs wrote.
  [ROOCODE_DENYLIST_TAG]: {
    apply: operation => applyRoocodeDenylistToFile(operation.destinationPath),
    remove: operation => removeRoocodeDenylistFromFile(operation.destinationPath),
    inspect: operation => inspectRoocodeDenylistFile(operation.destinationPath),
  },
  [CRUSH_PRE_TOOL_USE_EVENT]: {
    apply: operation => applyCrushHookToFile(operation.destinationPath, operation.hookScriptPath, operation.hookMatcher),
    remove: operation => removeCrushHookFromFile(operation.destinationPath, operation.hookScriptPath),
    inspect: operation => inspectCrushHookFile(operation.destinationPath, operation.hookScriptPath, operation.hookMatcher),
  },
  // Mistral Vibe: [[hooks]] tables in hooks.toml, by hook name
  // (scripts/lib/vibe-hooks-toml.js).
  [VIBE_PRE_TOOL_EVENT]: VIBE_HOOK_OPERATION_HANDLERS,
  // Kimi Code CLI: a [[hooks]] table in config.toml, by the adapter its
  // command runs (scripts/lib/kimi-hooks-toml.js).
  [KIMI_PRE_TOOL_EVENT]: KIMI_HOOK_OPERATION_HANDLERS,
};

const SESSION_START_HOOK_OPERATION_HANDLERS = {
  apply: operation => applySessionStartHookToFile(operation.destinationPath, operation.hookScriptPath),
  remove: operation => removeSessionStartHookFromFile(operation.destinationPath, operation.hookScriptPath),
  inspect: operation => inspectSessionStartHookFile(operation.destinationPath, operation.hookScriptPath),
};

// Any hookEvent not present in HOOK_EVENT_OPERATION_HANDLERS (currently just
// SessionStart itself) falls back to the SessionStart handler trio -- this is
// the trailing `else` branch every original dispatch chain ended with.
function resolveHookOperationHandlers(hookEvent) {
  return HOOK_EVENT_OPERATION_HANDLERS[hookEvent] || SESSION_START_HOOK_OPERATION_HANDLERS;
}

// Shared by install/apply.js and install-lifecycle.js's repair path: both
// need the exact same HOOK_OPERATION_KIND dispatch (SessionStart is the
// fallback for any event not explicitly handled above it), so it lives here
// once instead of being duplicated per caller.
function applyManagedHookOperation(operation) {
  resolveHookOperationHandlers(operation.hookEvent).apply(operation);
}

module.exports = {
  applyManagedHookOperation,
  resolveHookOperationHandlers,
  CRUSH_PRE_TOOL_USE_EVENT,
  KIMI_PRE_TOOL_EVENT,
  VIBE_PRE_TOOL_EVENT,
};
