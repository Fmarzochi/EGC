'use strict';

const { createFlatSkillPlanOperations, createRemappedOperation } = require('./install-targets/helpers');

// The plan of the Kimi Code home: skills flat under <root>/skills and the
// other families as library folders, then the Guardian adapter and its
// validators under <root>/scripts and the [[hooks]] entry in
// <root>/config.toml. The hook modules are required here, not at load time,
// because claude-settings-hooks.js itself loads kimi-hooks-toml.js for the
// hook operation handlers.
function planKimiOperations(input, adapter) {
  const {
    createKimiGuardianHookMergeOperation,
    createKimiGuardianScriptCopyOperations,
  } = require('./kimi-hooks-toml');
  const targetRoot = adapter.resolveRoot(input ?? {});
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  return [
    ...createFlatSkillPlanOperations(input, adapter),
    ...createKimiGuardianScriptCopyOperations(remap, targetRoot),
    createKimiGuardianHookMergeOperation(targetRoot),
  ];
}

module.exports = { planKimiOperations };
