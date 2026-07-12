const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  createWindsurfGateGuardOperations,
} = require('../windsurf-gateguard-operations');

module.exports = createInstallTargetAdapter({
  id: 'windsurf-home',
  target: 'windsurf',
  kind: 'home',
  rootSegments: ['.codeium', 'windsurf'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.codeium/windsurf',
  planOperations(input, adapter) {
    const planningInput = {
      repoRoot: input.repoRoot,
      projectRoot: input.projectRoot,
      homeDir: input.homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

    return [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createWindsurfGateGuardOperations(adapter, targetRoot, createRemappedOperation),
    ];
  },
});
