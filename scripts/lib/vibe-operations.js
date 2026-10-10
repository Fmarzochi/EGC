'use strict';

const {
  createFlatSkillPlanOperations,
  createRemappedOperation,
} = require('./install-targets/helpers');

// The plan both Vibe scopes share: skills flat under <root>/skills, the
// other families as library folders, then the Guardian and Token Crusher
// scripts under <root>/scripts and their [[hooks]] entries in
// <root>/hooks.toml. The hook modules are required here, not at load time,
// because claude-settings-hooks.js itself loads vibe-hooks-toml.js for the
// hook operation handlers.
function planVibeOperations(input, adapter) {
  const { createCrusherScriptCopyOperations } = require('./claude-settings-hooks');
  const {
    createVibeCrusherAdapterCopyOperation,
    createVibeCrusherHookMergeOperation,
    createVibeGuardianHookMergeOperation,
    createVibeGuardianScriptCopyOperations,
  } = require('./vibe-hooks-toml');
  const targetRoot = adapter.resolveRoot(input ?? {});
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  return [
    ...createFlatSkillPlanOperations(input, adapter),
    ...createVibeGuardianScriptCopyOperations(remap, targetRoot),
    ...createCrusherScriptCopyOperations(remap, targetRoot),
    createVibeCrusherAdapterCopyOperation(remap, targetRoot),
    createVibeGuardianHookMergeOperation(targetRoot),
    createVibeCrusherHookMergeOperation(targetRoot),
  ];
}

module.exports = { planVibeOperations };
