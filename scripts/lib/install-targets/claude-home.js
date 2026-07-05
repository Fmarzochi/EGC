const path = require('path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
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
  resolveHookScriptDestination,
  resolveStopHookScriptDestination,
} = require('../claude-settings-hooks');

const HOOK_LIB_SOURCES = [
  'scripts/lib/propagate-state.js',
  'scripts/lib/project-detect.js',
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
    const modules = Array.isArray(input.modules)
      ? input.modules
      : (input.module ? [input.module] : []);
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
        .flatMap(sourceRelativePath => {
          const normalizedPath = normalizeRelativePath(sourceRelativePath);

          // Claude Code discovers skills at ~/.claude/skills/<name>/ (flat).
          // Strip the leading category segment to match the expected structure.
          if (normalizedPath.startsWith('skills/')) {
            const parts = normalizedPath.slice('skills/'.length).split('/');
            const flatRemainder = parts.length >= 2 ? parts.slice(1).join('/') : parts.join('/');
            return [
              createRemappedOperation(
                adapter,
                module.id,
                sourceRelativePath,
                path.join(targetRoot, 'skills', flatRemainder),
                { strategy: 'preserve-relative-path' }
              ),
            ];
          }

          return [adapter.createScaffoldOperation(module.id, sourceRelativePath, planningInput)];
        });
    });

    // Deterministic memory loading: every Claude Code install registers the
    // SessionStart state hook, even when no content modules are selected.
    return [
      ...moduleOperations,
      ...createSessionStateHookOperations(adapter, targetRoot),
    ];
  },
});
