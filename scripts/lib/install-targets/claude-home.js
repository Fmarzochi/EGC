const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  planFlatSkillOperation,
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
  resolveHookScriptDestination,
  resolveStopHookScriptDestination,
} = require('../claude-settings-hooks');

const HOOK_LIB_SOURCES = [
  'scripts/lib/branch-state.js',
  'scripts/lib/global-state.js',
  'scripts/lib/project-detect.js',
  'scripts/lib/propagate-state.js',
  'scripts/lib/state-crypto.js',
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
    let modules;
    if (Array.isArray(input.modules)) {
      modules = input.modules;
    } else if (input.module) {
      modules = [input.module];
    } else {
      modules = [];
    }
    const planningInput = {
      repoRoot: input.repoRoot,
      projectRoot: input.projectRoot,
      homeDir: input.homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

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
