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

// Session-mesh wake-signal notice: Kiro's hook panel (.kiro/hooks/*.json)
// runs a UserPromptSubmit command whose stdout becomes agent context, so the
// shared script ships under the adapter root and a dedicated hook document
// points at it with --format=text. See kiro-mesh-hooks.js for the evidence.
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
  id: 'kiro-project',
  target: 'kiro',
  kind: 'project',
  rootSegments: ['.kiro'],
  installStatePathSegments: ['egc-install-state.json'],
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
