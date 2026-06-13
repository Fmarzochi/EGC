const path = require('path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
} = require('./helpers');
const {
  HOOK_MODULE_ID,
  HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  createSessionStartHookMergeOperation,
  resolveHookScriptDestination,
} = require('../claude-settings-hooks');

function createSessionStateHookOperations(adapter, targetRoot) {
  return [
    createRemappedOperation(
      adapter,
      HOOK_MODULE_ID,
      HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    createSessionStartHookMergeOperation(targetRoot),
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
        .filter(p => !isForeignPlatformPath(p, adapter.target))
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
