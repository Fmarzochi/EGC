const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  createGateGuardScriptCopyOperations,
  createPreToolUseGateGuardHookMergeOperation,
} = require('../claude-settings-hooks');

// Continue CLI's hooks system is deliberately Claude Code-compatible: it
// reads ~/.continue/settings.json (and ~/.claude/settings.json) with the
// exact same {hooks: {PreToolUse: [{matcher, hooks: [{type, command}]}]}}
// schema, and its tool_name values for edits/shell are the same "Edit",
// "Write", "MultiEdit", "Bash" strings Claude Code uses (confirmed against
// extensions/cli/src/hooks/types.ts and hookConfig.ts in continuedev/continue).
// So the merge operation built for Claude Code applies unchanged here, once
// the gate script itself is copied into Continue's own root.
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
      ...createContinueGateGuardOperations(adapter, targetRoot),
    ];
  },
});
