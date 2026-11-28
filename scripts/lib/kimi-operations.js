'use strict';

const { createFlatSkillPlanOperations, createRemappedOperation } = require('./install-targets/helpers');

// The plan of the Kimi Code home: skills flat under <root>/skills and the
// other families as library folders, then the Guardian adapter and its
// validators under <root>/scripts and the [[hooks]] entry in
// <root>/config.toml, then the session hooks (the wrapper of the shared
// session start, the Team Brain push and what they load, under
// <root>/scripts, with the files the Guardian already plants left to it)
// and their two [[hooks]] entries. The hook modules are required here, not
// at load time, because claude-settings-hooks.js itself loads
// kimi-hooks-toml.js for the hook operation handlers.
function planKimiOperations(input, adapter) {
  const {
    KIMI_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH,
    createKimiGuardianHookMergeOperation,
    createKimiGuardianScriptCopyOperations,
    createKimiSessionHookMergeOperations,
  } = require('./kimi-hooks-toml');
  const { createHostSessionHookCopyOperations } = require('./claude-settings-hook-copy-operations');
  const targetRoot = adapter.resolveRoot(input ?? {});
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  const planned = [
    ...createFlatSkillPlanOperations(input, adapter),
    ...createKimiGuardianScriptCopyOperations(remap, targetRoot),
    createKimiGuardianHookMergeOperation(targetRoot),
  ];
  return [
    ...planned,
    ...createHostSessionHookCopyOperations(remap, targetRoot, KIMI_SESSION_START_SCRIPT_SOURCE_RELATIVE_PATH, new Set(planned.map(operation => operation.destinationPath))),
    ...createKimiSessionHookMergeOperations(targetRoot),
  ];
}

module.exports = { planKimiOperations };
