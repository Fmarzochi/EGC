const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  planFlatSkillOperation,
  resolveModulesPlan,
} = require('./helpers');

const CLAUDE_EXCLUDED_SOURCE_PREFIXES = [
  'mcp-configs',
  'scripts/auto-update.js',
  'scripts/setup-package-manager.js',
];

function isClaudeExcludedPath(sourceRelativePath) {
  const normalized = normalizeRelativePath(sourceRelativePath);
  return CLAUDE_EXCLUDED_SOURCE_PREFIXES.some(
    prefix => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}
const {
  HOOK_MODULE_ID,
  HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  STOP_HOOK_MODULE_ID,
  STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  createSessionStartHookMergeOperation,
  createStopHookMergeOperation,
  createUserPromptSubmitHookMergeOperation,
  createUserPromptSubmitRouterHookMergeOperation,
  createPreToolUseBashDispatcherHookMergeOperation,
  createPreToolUseWriteValidatorHookMergeOperation,
  createPreToolUseGateGuardHookMergeOperation,
  createPreCompactHookMergeOperation,
  createPostCompactHookMergeOperation,
  createEgcMemorySaveScriptCopyOperations,
  resolveHookScriptDestination,
  resolveStopHookScriptDestination,
} = require('../claude-settings-hooks');

const HOOK_LIB_SOURCES = [
  'scripts/lib/session-start-adapter.js',
  // Flattens next to the adapter; its require falls back from
  // ./crusher/session-marker to ./session-marker for exactly this layout.
  'scripts/lib/crusher/session-marker.js',
  'scripts/lib/session-context-loader.js',
  'scripts/lib/branch-state.js',
  'scripts/lib/global-state.js',
  'scripts/lib/project-detect.js',
  'scripts/lib/propagate-state.js',
  'scripts/lib/state-crypto.js',
  // propagate-state.js's commit-privacy guard shells out to this script as
  // the git clean-filter command -- it must land next to propagate-state.js
  // (both flatten to the same libDestDir below), or the filter config points
  // at a path that never existed on this machine (cubic review, audit EGC-547).
  'scripts/check-state-leak.js',
];

function createSessionStateHookOperations(adapter, targetRoot) {
  const libDestDir = path.join(targetRoot, 'egc', 'lib');
  const libOperations = HOOK_LIB_SOURCES.map(src =>
    createRemappedOperation(
      adapter,
      HOOK_MODULE_ID,
      src,
      path.join(libDestDir, path.basename(src)),
      { strategy: 'preserve-relative-path' }
    )
  );

  return [
    createRemappedOperation(
      adapter,
      HOOK_MODULE_ID,
      HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    ...libOperations,
    createSessionStartHookMergeOperation(targetRoot),
    createRemappedOperation(
      adapter,
      STOP_HOOK_MODULE_ID,
      STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveStopHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    createStopHookMergeOperation(targetRoot),
    // PreCompact -> egc-memory-save.js (guaranteed snapshot save + prompts
    // update_state), PostCompact -> reuses claude-session-start.js (same
    // proven state-load-and-print logic SessionStart already uses, already
    // copied above via HOOK_SCRIPT_SOURCE_RELATIVE_PATH/libOperations).
    // Closes EGC-495 (no mechanism previously re-injected state after a
    // context compaction). Like SessionStart/Stop above, egc-memory-save.js
    // and its lib dependencies are copied unconditionally here rather than
    // left to an optional module, so a minimal install never registers a
    // PreCompact hook pointing at a script that was never copied to disk.
    ...createEgcMemorySaveScriptCopyOperations(
      (moduleId, sourceRelativePath, destinationPath, options) =>
        createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options),
      targetRoot
    ),
    createPreCompactHookMergeOperation(targetRoot),
    createPostCompactHookMergeOperation(targetRoot),
    createUserPromptSubmitHookMergeOperation(targetRoot),
    createUserPromptSubmitRouterHookMergeOperation(targetRoot),
    createPreToolUseBashDispatcherHookMergeOperation(targetRoot),
    createPreToolUseWriteValidatorHookMergeOperation(targetRoot, 'Edit'),
    createPreToolUseWriteValidatorHookMergeOperation(targetRoot, 'Write'),
    createPreToolUseWriteValidatorHookMergeOperation(targetRoot, 'MultiEdit'),
    // GateGuard fact-forcing gate: Bash already gets this via
    // bash-hook-dispatcher.js above. Edit/Write/MultiEdit only had the
    // protected-path validator until now, so register GateGuard on them
    // too (in addition to, not instead of, the write validator).
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'Edit'),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'Write'),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'MultiEdit'),
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'claude-home',
  target: 'claude',
  kind: 'home',
  rootSegments: ['.claude'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.claude',
  planOperations(input, adapter) {
    const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);

    const moduleOperations = modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(p => !isForeignPlatformPath(p, adapter.target) && !isClaudeExcludedPath(p))
        .map(sourceRelativePath => planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot));
    });

    // Deterministic memory loading: every Claude Code install registers the
    // SessionStart state hook, even when no content modules are selected.
    return [
      ...moduleOperations,
      ...createSessionStateHookOperations(adapter, targetRoot),
    ];
  },
});
