const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  resolveModulesPlan,
} = require('./helpers');
const {
  BASH_GUARDIAN_HOOK_MODULE_ID,
  createBashGuardianScriptCopyOperations,
  createCrusherScriptCopyOperations,
} = require('../claude-settings-hooks');

// OpenCode plugins run in-process, unlike hosts that spawn hooks.json
// commands. Guardian and Crusher can run directly, while session restoration
// crosses a fail-open Node child-process boundary through the OpenCode adapter
// below. The adapter and Claude hook both consume the same host-neutral core.
const PLUGIN_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/opencode-egc-plugin.js';
const SESSION_CONTEXT_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/opencode-session-start.js';
const OPENCODE_SESSION_CONTEXT_MODULE_ID = 'opencode-session-context-hook';

// Keep this dependency set aligned with claude-home.js's SessionStart hook.
// The shared loader treats every helper as optional, but normal installations
// should preserve branch-aware, encrypted, global, propagated, and stack-aware
// restoration on both hosts.
const SESSION_CONTEXT_LIB_SOURCES = [
  'scripts/lib/session-start-adapter.js',
  'scripts/lib/session-context-loader.js',
  'scripts/lib/branch-state.js',
  'scripts/lib/global-state.js',
  'scripts/lib/project-detect.js',
  'scripts/lib/propagate-state.js',
  'scripts/lib/state-crypto.js',
  // propagate-state.js's commit-privacy guard shells out to this script as
  // the git clean-filter command -- must be present (this target preserves
  // the scripts/ prefix, so it lands one level up from propagate-state.js,
  // exactly where the runtime falls back to looking), or the filter config
  // points at a path that never existed on this machine (cubic review,
  // audit EGC-547).
  'scripts/check-state-leak.js',
];

function resolvePluginScriptDestination(targetRoot) {
  return path.join(targetRoot, 'plugins', 'opencode-egc-plugin.js');
}

function createOpenCodeSessionContextOperations(remap, targetRoot) {
  return [
    remap(
      OPENCODE_SESSION_CONTEXT_MODULE_ID,
      SESSION_CONTEXT_SCRIPT_SOURCE_RELATIVE_PATH,
      path.join(targetRoot, 'scripts', 'hooks', 'opencode-session-start.js'),
      { strategy: 'preserve-relative-path' }
    ),
    ...SESSION_CONTEXT_LIB_SOURCES.map(sourceRelativePath => remap(
      OPENCODE_SESSION_CONTEXT_MODULE_ID,
      sourceRelativePath,
      path.join(targetRoot, ...sourceRelativePath.split('/')),
      { strategy: 'preserve-relative-path' }
    )),
  ];
}

function createOpenCodePluginOperations(adapter, targetRoot) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  const pluginCopyOperation = createRemappedOperation(
    adapter,
    BASH_GUARDIAN_HOOK_MODULE_ID,
    PLUGIN_SCRIPT_SOURCE_RELATIVE_PATH,
    resolvePluginScriptDestination(targetRoot),
    { strategy: 'preserve-relative-path' }
  );

  return [
    ...createBashGuardianScriptCopyOperations(remap, targetRoot),
    ...createCrusherScriptCopyOperations(remap, targetRoot),
    ...createOpenCodeSessionContextOperations(remap, targetRoot),
    pluginCopyOperation,
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'opencode-home',
  target: 'opencode',
  kind: 'home',
  rootSegments: ['.config', 'opencode'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.opencode',
  planOperations(input, adapter) {
    const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);

    const moduleOperations = modules.flatMap(module => {
      const paths = (Array.isArray(module.paths) ? module.paths : [])
        .filter(p => !isForeignPlatformPath(p, adapter.target));
      return paths.flatMap(sourceRelativePath => {
        const normalizedPath = normalizeRelativePath(sourceRelativePath);

        // OpenCode discovers skills at ~/.config/opencode/skills/<name>/ (flat).
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

    return [
      ...moduleOperations,
      ...createOpenCodePluginOperations(adapter, targetRoot),
    ];
  },
});
