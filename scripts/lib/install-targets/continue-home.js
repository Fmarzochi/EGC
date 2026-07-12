const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  createContinueGateGuardOperations,
} = require('../continue-gateguard-hooks');

module.exports = createInstallTargetAdapter({
  id: 'continue-home',
  target: 'continue',
  kind: 'home',
  rootSegments: ['.continue'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.continue',
  planOperations(input, adapter) {
    const planningInput = {
      repoRoot: input.repoRoot,
      projectRoot: input.projectRoot,
      homeDir: input.homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

    return [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createContinueGateGuardOperations(adapter, targetRoot, createRemappedOperation),
    ];
  },
});
