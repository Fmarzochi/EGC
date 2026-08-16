const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const { createKiroGuardianOperations } = require('../kiro-guardian-operations');
const { createKiroMeshNoticeOperations } = require('../kiro-mesh-operations');

module.exports = createInstallTargetAdapter({
  id: 'kiro-home',
  target: 'kiro',
  kind: 'home',
  rootSegments: ['.kiro'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.kiro',
  planOperations(input, adapter) {
    const planningInput = {
      repoRoot: input.repoRoot,
      projectRoot: input.projectRoot,
      homeDir: input.homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

    return [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createKiroGuardianOperations(adapter, targetRoot, createRemappedOperation),
      ...createKiroMeshNoticeOperations(adapter, targetRoot, createRemappedOperation),
    ];
  },
});
