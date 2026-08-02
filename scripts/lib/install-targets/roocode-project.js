const { createDefaultScaffoldOperations, createInstallTargetAdapter } = require('./helpers');
const { createRoocodeDenylistMergeOperation } = require('../claude-settings-hooks');
const { resolveVsCodeSettingsPath } = require('../roocode-guardian-denylist');

// Roo Code has no external hook API (see roocode-guardian-denylist.js's own
// header for the confirmed evidence against its official docs), so unlike
// every other install target here this cannot wire the real Guardian
// validator. The closest real substitute -- seeding Roo Code's own native
// roo-cline.deniedCommands setting -- lives in the workspace's own
// .vscode/settings.json at the project root, not under this adapter's own
// .roo/rules root, so it is planned against input.projectRoot (falling back
// to input.repoRoot for repoRoot-only call paths, same as every other
// adapter here) instead of the rules-scoped targetRoot.
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
    const settingsPath = resolveVsCodeSettingsPath(input.projectRoot || input.repoRoot);
    return [
      ...createDefaultScaffoldOperations(input, adapter),
      createRoocodeDenylistMergeOperation(settingsPath),
    ];
  },
});
