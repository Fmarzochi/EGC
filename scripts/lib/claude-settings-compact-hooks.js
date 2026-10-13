'use strict';

// PreCompact and PostCompact hook entries and the memory-save script copy operations.
// Part of the claude-settings-hooks.js split; that file re-exports the public surface.

const path = require('node:path');
const {
  HOOK_OPERATION_KIND,
  HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  HOOK_MODULE_ID,
  PRE_COMPACT_EVENT,
  POST_COMPACT_EVENT,
  EGC_MEMORY_SAVE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  EGC_MEMORY_SAVE_HOOK_MODULE_ID,
  buildHookCommand,
  resolveHookScriptDestination,
  resolveSettingsPath,
  hasHookEntry,
  addHookEntry,
  removeHookEntry,
  applyHookEntryToFile,
  removeHookEntryFromFile,
  inspectHookEntryFile,
} = require('./claude-settings-hook-core');

// PreCompact -> egc-memory-save hook: closes EGC-495 (no mechanism re-injected
// state after a context compaction). egc-memory-save.js writes a guaranteed
// on-disk snapshot (writeSnapshotToDisk, no AI cooperation required) and
// echoes a promptForAssistant asking the model to call update_state with the
// session's decisions/preferences/next-steps -- this stdout is what a
// PreCompact hook contributes to the surviving post-compaction context
// (confirmed empirically: PreCompact hook stdout is not swept away by
// summarization the way regular turn history is). Its dependency chain is
// egc-memory-save.js -> lib/state-snapshot.js -> lib/branch-state.js,
// lib/state-crypto.js and lib/state-integrity.js (which also needs
// state-crypto.js); every one is required when the hook loads.
// state-crypto.js now also requires lib/utils.js for its HOME/USERPROFILE
// resolution (C06, unifying it with the rest of the package), so utils.js
// must travel with it here too, the same way it already does in
// HOOK_LIB_SOURCES above.
const EGC_MEMORY_SAVE_HOOK_LIB_SOURCES = [
  'scripts/lib/state-snapshot.js',
  'scripts/lib/branch-state.js',
  'scripts/lib/state-crypto.js',
  'scripts/lib/state-integrity.js',
  'scripts/lib/utils.js',
  'scripts/lib/hook-stdin.js',
];

function resolveEgcMemorySaveHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'egc-memory-save.js');
}

function hasPreCompactHook(settings, hookScriptPath) {
  return hasHookEntry(settings, PRE_COMPACT_EVENT, hookScriptPath);
}

function addPreCompactHook(settings, hookScriptPath) {
  return addHookEntry(settings, PRE_COMPACT_EVENT, hookScriptPath);
}

function removePreCompactHook(settings, hookScriptPath) {
  return removeHookEntry(settings, PRE_COMPACT_EVENT, hookScriptPath);
}

function applyPreCompactHookToFile(settingsPath, hookScriptPath) {
  return applyHookEntryToFile(settingsPath, PRE_COMPACT_EVENT, hookScriptPath);
}

function removePreCompactHookFromFile(settingsPath, hookScriptPath) {
  return removeHookEntryFromFile(settingsPath, PRE_COMPACT_EVENT, hookScriptPath);
}

function inspectPreCompactHookFile(settingsPath, hookScriptPath) {
  return inspectHookEntryFile(settingsPath, PRE_COMPACT_EVENT, hookScriptPath);
}

function createPreCompactHookMergeOperation(targetRoot) {
  const hookScriptPath = resolveEgcMemorySaveHookScriptDestination(targetRoot);
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: EGC_MEMORY_SAVE_HOOK_MODULE_ID,
    sourceRelativePath: EGC_MEMORY_SAVE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: resolveSettingsPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_COMPACT_EVENT,
    hookScriptPath,
    hookCommand: buildHookCommand(hookScriptPath),
  };
}

// Destination-driven variant, for hosts whose hooks.json path is not
// derivable from targetRoot (Copilot ~/.copilot/hooks, Antigravity's
// project/global split). Same Claude hooks.json schema. Only wire this for a
// host confirmed to actually fire PreCompact -- unlike PreToolUse, this event
// is not documented publicly for every host, so callers must verify first
// (see EGC-497) rather than wiring it blindly the way Crusher's Fase B did.
function createPreCompactHookMergeOperationForDestination(destinationPath, hookScriptPath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: EGC_MEMORY_SAVE_HOOK_MODULE_ID,
    sourceRelativePath: EGC_MEMORY_SAVE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_COMPACT_EVENT,
    hookScriptPath,
    hookCommand: buildHookCommand(hookScriptPath),
  };
}

function createEgcMemorySaveScriptCopyOperations(createRemappedOperation, targetRoot) {
  return [
    createRemappedOperation(
      EGC_MEMORY_SAVE_HOOK_MODULE_ID,
      EGC_MEMORY_SAVE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveEgcMemorySaveHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    ...EGC_MEMORY_SAVE_HOOK_LIB_SOURCES.map(src => createRemappedOperation(
      EGC_MEMORY_SAVE_HOOK_MODULE_ID,
      src,
      path.join(targetRoot, ...src.split('/')),
      { strategy: 'preserve-relative-path' }
    )),
  ];
}

// PostCompact -> reuses claude-session-start.js (already scaffolded for
// SessionStart, no extra copy operation needed). readStdinJson() there
// already falls back to {} on missing/invalid stdin and resolveProjectPath()
// falls back to CLAUDE_PROJECT_DIR/PWD/cwd() when input.cwd is absent, so the
// exact same tested, proven state-load-and-print logic that opens every
// session also re-injects state right after a compaction finishes -- closes
// EGC-495 without inventing new untested logic. Confirmed real by an
// internal audit (EGC-497) via Claude Code binary inspection: PostCompact is
// an actual hook event (executePostCompactHooks, markPostCompaction).
function createPostCompactHookMergeOperation(targetRoot) {
  const hookScriptPath = resolveHookScriptDestination(targetRoot);
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: HOOK_MODULE_ID,
    sourceRelativePath: HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: resolveSettingsPath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: POST_COMPACT_EVENT,
    hookScriptPath,
    hookCommand: buildHookCommand(hookScriptPath),
  };
}

module.exports = {
  addPreCompactHook,
  applyPreCompactHookToFile,
  createEgcMemorySaveScriptCopyOperations,
  createPreCompactHookMergeOperation,
  createPreCompactHookMergeOperationForDestination,
  createPostCompactHookMergeOperation,
  resolveEgcMemorySaveHookScriptDestination,
  hasPreCompactHook,
  inspectPreCompactHookFile,
  removePreCompactHook,
  removePreCompactHookFromFile,
};
