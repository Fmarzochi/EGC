'use strict';

const path = require('node:path');

const {
  createFlatSkillPlanOperations,
  createRemappedOperation,
} = require('./install-targets/helpers');

const LIBRARY_FAMILIES = new Set(['agents', 'commands', 'rules']);
const LIBRARY_ROOT_SEGMENTS = ['egc', 'library'];

// Vibe reads agents/ (TOML profiles) and prompts/ under its root, so the
// families it cannot run natively go under egc/library/, where nothing of
// Vibe's looks: a Markdown agent dropped into agents/ would be a profile
// Vibe cannot parse.
function relocateLibraryFolders(operations, targetRoot) {
  return operations.map(operation => {
    const relative = path.relative(targetRoot, operation.destinationPath).split(path.sep);
    if (!LIBRARY_FAMILIES.has(relative[0])) return operation;
    return { ...operation, destinationPath: path.join(targetRoot, ...LIBRARY_ROOT_SEGMENTS, ...relative) };
  });
}

// The root AGENTS.md is the user-level instructions file Vibe reads from
// its home root for every project. In a project Vibe reads the AGENTS.md of
// the working directory itself, the one the memory propagation keeps at
// the repository root, so the project scope plans no copy under .vibe.
function keepsRootAgentsFile(adapter, targetRoot, operation) {
  return adapter.kind === 'home' || path.relative(targetRoot, operation.destinationPath) !== 'AGENTS.md';
}

// The plan both Vibe scopes share: skills flat under <root>/skills, the
// other families under <root>/egc/library, then the Guardian and Token
// Crusher scripts under <root>/scripts and their [[hooks]] entries in
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
  const moduleOperations = createFlatSkillPlanOperations(input, adapter)
    .filter(operation => keepsRootAgentsFile(adapter, targetRoot, operation));

  return [
    ...relocateLibraryFolders(moduleOperations, targetRoot),
    ...createVibeGuardianScriptCopyOperations(remap, targetRoot),
    ...createCrusherScriptCopyOperations(remap, targetRoot),
    createVibeCrusherAdapterCopyOperation(remap, targetRoot),
    createVibeGuardianHookMergeOperation(targetRoot),
    createVibeCrusherHookMergeOperation(targetRoot),
  ];
}

module.exports = { planVibeOperations };
