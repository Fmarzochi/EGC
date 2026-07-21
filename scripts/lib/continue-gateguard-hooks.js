'use strict';

// Continue CLI's hooks system is deliberately Claude Code-compatible: it
// reads ~/.continue/settings.json (and ~/.claude/settings.json) with the
// exact same {hooks: {PreToolUse: [{matcher, hooks: [{type, command}]}]}}
// schema, and its tool_name values for edits/shell are the same "Edit",
// "Write", "MultiEdit", "Bash" strings Claude Code uses (confirmed against
// extensions/cli/src/hooks/types.ts and hookConfig.ts in continuedev/continue).
// So the merge operation built for Claude Code applies unchanged here, once
// the gate script itself is copied into Continue's own root. Shared between
// continue-home.js and continue-project.js: .continue/settings.json (project)
// is read at the same precedence tier as .claude/settings.json, and the home
// variant only differs in rootSegments/installStatePathSegments.

const {
  createGateGuardScriptCopyOperations,
  createPreToolUseGateGuardHookMergeOperation,
  createCrusherScriptCopyOperations,
  createPreToolUseCrusherHookMergeOperation,
} = require('./claude-settings-hooks');

function createContinueGateGuardOperations(adapter, targetRoot, createRemappedOperation) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );
  const copyOperations = createGateGuardScriptCopyOperations(remap, targetRoot);

  const mergeOperations = ['Edit', 'Write', 'MultiEdit', 'Bash'].map(matcher => (
    createPreToolUseGateGuardHookMergeOperation(targetRoot, matcher)
  ));

  // Token Crusher: Continue reads the same hooks.json schema as Claude Code, so
  // scaffold the standalone hook + its deps and register it on Bash. Fail-open,
  // so a Continue build that ignores updatedInput just runs the command as-is.
  const crusherOperations = [
    ...createCrusherScriptCopyOperations(remap, targetRoot),
    createPreToolUseCrusherHookMergeOperation(targetRoot, 'Bash'),
  ];

  return [...copyOperations, ...mergeOperations, ...crusherOperations];
}

module.exports = { createContinueGateGuardOperations };
