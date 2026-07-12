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
} = require('./claude-settings-hooks');

function createContinueGateGuardOperations(adapter, targetRoot, createRemappedOperation) {
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

module.exports = { createContinueGateGuardOperations };
