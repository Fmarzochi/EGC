const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  createWindsurfGateGuardOperations,
} = require('../windsurf-gateguard-operations');

module.exports = createInstallTargetAdapter({
  id: 'windsurf-project',
  target: 'windsurf',
  kind: 'project',
  rootSegments: ['.windsurf'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.windsurf',
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
