const { createInstallTargetAdapter, isForeignPlatformPath } = require('./helpers');
const { createRoocodeDenylistMergeOperation } = require('../claude-settings-hooks');
const { resolveVsCodeSettingsPath } = require('../roocode-guardian-denylist');

// Same default-scaffold behavior createInstallTargetAdapter would otherwise
// supply on its own (preserve category structure, no flat stripping) --
// replicated here, not deleted, because defining a custom planOperations
// below (needed to also emit the deniedCommands merge) replaces that
// built-in default entirely. Mirrors amazonq-project.js's own copy of this
// same logic for the same reason.
function createDefaultScaffoldOperations(input, adapter) {
  if (Array.isArray(input.modules)) {
    return input.modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(p => !isForeignPlatformPath(p, adapter.target))
        .map(sourceRelativePath => adapter.createScaffoldOperation(module.id, sourceRelativePath, input));
    });
  }

  const module = input.module || {};
  const paths = Array.isArray(module.paths) ? module.paths : [];
  return paths
    .filter(p => !isForeignPlatformPath(p, adapter.target))
    .map(sourceRelativePath => adapter.createScaffoldOperation(module.id, sourceRelativePath, input));
}

// Roo Code has no external hook API (see roocode-guardian-denylist.js's own
// header for the confirmed evidence against its official docs), so unlike
// every other install target here this cannot wire the real Guardian
// validator. The closest real substitute -- seeding Roo Code's own native
// roo-cline.deniedCommands setting -- lives in the workspace's own
// .vscode/settings.json at the project root, not under this adapter's own
// .roo/rules root, so it is planned against input.projectRoot directly.
module.exports = createInstallTargetAdapter({
  id: 'roocode-project',
  target: 'roocode',
  kind: 'project',
  rootSegments: ['.roo', 'rules'],
  installStatePathSegments: ['egc-install-state.json'],
  // rootSegments already ends in 'rules', matching rules-core's own module
  // path ('rules'): nativeRootRelativePath must equal that source path (not
  // '.roo', never exercised by any module) so resolveDestinationPath syncs
  // root children directly instead of nesting rules/rules/.
  nativeRootRelativePath: 'rules',
  planOperations(input, adapter) {
    const settingsPath = resolveVsCodeSettingsPath(input.projectRoot);
    return [
      ...createDefaultScaffoldOperations(input, adapter),
      createRoocodeDenylistMergeOperation(settingsPath),
    ];
  },
});
