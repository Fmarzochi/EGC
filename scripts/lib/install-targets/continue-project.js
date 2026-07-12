const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  createGateGuardScriptCopyOperations,
  createPreToolUseGateGuardHookMergeOperation,
} = require('../claude-settings-hooks');

// See continue-home.js for why the Claude Code merge operation is reusable
// as-is: Continue CLI's PreToolUse hook schema and tool_name values are
// intentionally Claude Code-compatible, and .continue/settings.json (project)
// is read at the same precedence tier as .claude/settings.json.
function createContinueGateGuardOperations(adapter, targetRoot) {
  const copyOperations = createGateGuardScriptCopyOperations(
    (moduleId, sourceRelativePath, destinationPath, options) => (
      createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
    ),
    targetRoot
  );

  const mergeOperations = ['Edit', 'Write', 'MultiEdit', 'Bash'].map(matcher => (
    createPreToolUseGateGuardHookMergeOperation(targetRoot, matcher)
  ));

  return [...copyOperations, ...mergeOperations];
}

module.exports = createInstallTargetAdapter({
  id: 'continue-project',
  target: 'continue',
  kind: 'project',
  rootSegments: ['.continue'],
  installStatePathSegments: ['egc-install-state.json'],
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
      ...createContinueGateGuardOperations(adapter, targetRoot),
    ];
  },
});
