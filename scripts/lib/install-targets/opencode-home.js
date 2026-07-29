const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
} = require('./helpers');
const {
  BASH_GUARDIAN_HOOK_MODULE_ID,
  createBashGuardianScriptCopyOperations,
  createCrusherScriptCopyOperations,
} = require('../claude-settings-hooks');

// OpenCode plugins run IN-PROCESS (Bun runtime), unlike every other target's
// externally-spawned hooks.json subprocess -- opencode-egc-plugin.js
// `require()`s pre-bash-guardian-validate.js's and
// pre-bash-crusher-rewrite.js's own run() functions directly, so there is no
// stdin/stdout translation adapter to wire, only a plugin file to drop into
// OpenCode's auto-discovered plugins/ directory (docs:
// https://opencode.ai/docs/plugins) alongside the same Guardian/Crusher
// script trees every other target copies via the shared builders below.
// EGC-498: OpenCode is the only one of the newly-researched hosts (Windsurf,
// Cursor, OpenCode, Kiro) whose hook contract can mutate the tool call
// (`output.args.command = ...`) before it runs, which the Token Crusher's
// rewrite-based design requires -- so it is the only one of the four wired
// for both the Guardian and the Crusher, not the Guardian alone.
const PLUGIN_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/opencode-egc-plugin.js';

function resolvePluginScriptDestination(targetRoot) {
  return path.join(targetRoot, 'plugins', 'opencode-egc-plugin.js');
}

function createOpenCodeGuardianCrusherOperations(adapter, targetRoot) {
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
      ...createOpenCodeGuardianCrusherOperations(adapter, targetRoot),
    ];
  },
});
