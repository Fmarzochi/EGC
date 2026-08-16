const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const { createKiroGuardianOperations } = require('../kiro-guardian-operations');
const {
  createMeshNoticeScriptCopyOperations,
  createKiroMeshHookFileOperation,
  resolveMeshNoticeHookScriptDestination,
} = require('../claude-settings-hooks');

// Session-mesh wake-signal notice: same panel-hook document as
// kiro-project.js, at the home-scope ~/.kiro/hooks/ location.
function createKiroMeshNoticeOperations(adapter, targetRoot) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  return [
    ...createMeshNoticeScriptCopyOperations(remap, targetRoot),
    createKiroMeshHookFileOperation(targetRoot, resolveMeshNoticeHookScriptDestination(targetRoot)),
  ];
}

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
      ...createKiroMeshNoticeOperations(adapter, targetRoot),
    ];
  },
});
