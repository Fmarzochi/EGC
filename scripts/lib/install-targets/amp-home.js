const os = require('node:os');
const path = require('node:path');
const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  BASH_GUARDIAN_HOOK_MODULE_ID,
  MESH_NOTICE_HOOK_MODULE_ID,
  createBashGuardianScriptCopyOperations,
  createCrusherScriptCopyOperations,
  createMeshNoticeScriptCopyOperations,
} = require('../claude-settings-hooks');

// GateGuard fact-forcing gate is intentionally NOT wired for Amp -- separate
// concern, out of scope for this pass (EGC-507).
//
// Guardian + Token Crusher via Amp's Plugin API (EGC-507, design reviewed
// with an internal audit before implementing, 2026-07-29): the hooks doc
// this file used to cite (ampcode.com/manual?internal#hooks,
// Sourcegraph-internal only, "Preview" since May 2025) now 404s. In its
// place, Amp ships a PUBLIC Plugin API (ampcode.com/manual/plugin-api, no
// preview/experimental badge) with a `tool.call` event whose `modify`
// action can rewrite a tool's input before it runs, plus
// `reject-and-continue` to block it -- covering both EGC mechanisms, same
// as OpenCode's plugin. See scripts/hooks/amp-guardian-crusher-plugin.ts
// for the full evidence trail and implementation.
//
// Global-scope plugins are NOT under this adapter's own ~/.amp root: Amp's
// docs are explicit that they live at ~/.config/amp/plugins/ (XDG-style),
// a genuinely different directory than ~/.amp/skills/ (the pre-existing
// skills path in this file, not re-verified here -- out of scope for
// EGC-507). So the plugin-related copy operations resolve their own root
// independently of adapter.resolveRoot() instead of reusing the skills
// targetRoot.
const PLUGIN_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/amp-guardian-crusher-plugin.ts';
const MESH_PLUGIN_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/amp-mesh-notice-plugin.ts';

function resolveAmpConfigRoot(homeDir) {
  return path.join(homeDir || os.homedir(), '.config', 'amp');
}

function resolvePluginScriptDestination(configRoot) {
  return path.join(configRoot, 'plugins', 'egc-guardian-crusher.ts');
}

function resolveMeshPluginScriptDestination(configRoot) {
  return path.join(configRoot, 'plugins', 'egc-mesh-notice.ts');
}

// Session-mesh wake-signal notice: agent.start plugin bridge, same
// in-process pattern as the Guardian/Crusher plugin above; the shared
// mesh-events-inject.js is copied under the config root so the plugin's
// relative require resolves at install time.
function createAmpMeshNoticeOperations(adapter, configRoot) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  return [
    ...createMeshNoticeScriptCopyOperations(remap, configRoot),
    remap(
      MESH_NOTICE_HOOK_MODULE_ID,
      MESH_PLUGIN_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveMeshPluginScriptDestination(configRoot),
      { strategy: 'preserve-relative-path' }
    ),
  ];
}

function createAmpGuardianCrusherOperations(adapter, configRoot) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  return [
    ...createBashGuardianScriptCopyOperations(remap, configRoot),
    ...createCrusherScriptCopyOperations(remap, configRoot),
    remap(
      BASH_GUARDIAN_HOOK_MODULE_ID,
      PLUGIN_SCRIPT_SOURCE_RELATIVE_PATH,
      resolvePluginScriptDestination(configRoot),
      { strategy: 'preserve-relative-path' }
    ),
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'amp-home',
  target: 'amp',
  kind: 'home',
  rootSegments: ['.amp'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.amp',
  planOperations(input, adapter) {
    const configRoot = resolveAmpConfigRoot(input.homeDir);

    return [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createAmpGuardianCrusherOperations(adapter, configRoot),
      ...createAmpMeshNoticeOperations(adapter, configRoot),
    ];
  },
});
