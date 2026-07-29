const path = require('node:path');
const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  BASH_GUARDIAN_HOOK_MODULE_ID,
  createBashGuardianScriptCopyOperations,
  createCrusherScriptCopyOperations,
} = require('../claude-settings-hooks');

// GateGuard fact-forcing gate is intentionally NOT wired for Amp -- it is a
// separate concern from Guardian/Crusher below and out of scope for this
// pass (EGC-507).
//
// Guardian + Token Crusher via Amp's Plugin API (EGC-507, design reviewed
// with the Multica squad before implementing): reconfirmed 2026-07-29 that
// the old hooks doc this file used to cite (ampcode.com/manual?internal#
// hooks, Sourcegraph-internal only) now 404s -- Amp replaced it with a
// PUBLIC Plugin API (ampcode.com/manual/plugin-api). Plugins run IN-PROCESS
// under Amp's own Bun runtime (confirmed on the docs page itself: "Plugins
// live in .amp/plugins/ ... and are executed using Bun"), same pattern as
// OpenCode's plugin (opencode-home.js / opencode-egc-plugin.js) -- no
// external-script stdin/stdout translation adapter needed, just a plugin
// file that requires the shared run() functions directly. tool.call's
// `modify` action can rewrite the tool input, so -- like OpenCode -- Amp
// gets both the Guardian and the Crusher, not the Guardian alone.
const PLUGIN_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/amp-guardian-crusher-plugin.ts';

function resolvePluginScriptDestination(targetRoot) {
  return path.join(targetRoot, 'plugins', 'egc-guardian-crusher.ts');
}

function createAmpGuardianCrusherOperations(adapter, targetRoot) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  return [
    ...createBashGuardianScriptCopyOperations(remap, targetRoot),
    ...createCrusherScriptCopyOperations(remap, targetRoot),
    remap(
      BASH_GUARDIAN_HOOK_MODULE_ID,
      PLUGIN_SCRIPT_SOURCE_RELATIVE_PATH,
      resolvePluginScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'amp-project',
  target: 'amp',
  kind: 'project',
  rootSegments: ['.amp'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.amp',
  planOperations(input, adapter) {
    const planningInput = {
      repoRoot: input.repoRoot,
      projectRoot: input.projectRoot,
      homeDir: input.homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

    return [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createAmpGuardianCrusherOperations(adapter, targetRoot),
    ];
  },
});
