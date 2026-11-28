'use strict';

const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  planFlatSkillOperation,
  resolveModulesPlan,
} = require('./helpers');

const LIBRARY_FAMILIES = new Set(['agents', 'rules']);
const LIBRARY_ROOT_SEGMENTS = ['egc', 'library'];
const SHELL_MATCHER = 'Execute';
const WRITE_MATCHER = 'Edit|Create|ApplyPatch';
// The session hooks, in the same settings.json and the same format ([Droid
// hooks](https://docs.factory.com/reference/hooks-reference), read on
// 2026-11-27): SessionStart gets session_id and cwd and reads
// additionalContext back into the context, so the project memory reaches the
// session and the Team Brain is pulled when the team asks for it; Stop pushes
// what changed. The Session Mesh notice rides UserPromptSubmit, whose stdout
// (plain text or additionalContext on exit 0) is added as context for the
// model (same reference, read on 2026-11-28): the shared mesh-events-inject.js
// runs alone, with no team sync beside it, since the session hooks carry it.
const DROID_SESSION_START_SOURCE_RELATIVE_PATH = 'scripts/hooks/droid-session-start.js';

function planDroidPath(adapter, module, sourceRelativePath, planningInput, targetRoot) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);
  if (LIBRARY_FAMILIES.has(normalizedPath.split('/')[0])) {
    return createRemappedOperation(adapter, module.id, sourceRelativePath, path.join(targetRoot, ...LIBRARY_ROOT_SEGMENTS, ...normalizedPath.split('/')), {
      strategy: 'preserve-relative-path',
    });
  }
  return planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot);
}

function createDroidHookOperations(adapter, targetRoot) {
  const {
    createBashGuardianHookMergeOperationForDestination,
    createBashGuardianScriptCopyOperations,
    createCrusherHookMergeOperationForDestination,
    createCrusherScriptCopyOperations,
    createWriteValidatorHookMergeOperationForDestination,
    createWriteValidatorScriptCopyOperation,
    createHostSessionHookOperations,
    createMeshNoticeHookMergeOperationForDestination,
    createMeshNoticeScriptCopyOperations,
    resolveMeshNoticeHookScriptDestination,
  } = require('../claude-settings-hooks');
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );
  const settingsPath = path.join(targetRoot, 'settings.json');
  const hooksDir = path.join(targetRoot, 'scripts', 'hooks');
  const gates = [
    ...createBashGuardianScriptCopyOperations(remap, targetRoot),
    createBashGuardianHookMergeOperationForDestination(settingsPath, path.join(hooksDir, 'pre-bash-guardian-validate.js'), SHELL_MATCHER),
    createWriteValidatorScriptCopyOperation(remap, targetRoot),
    createWriteValidatorHookMergeOperationForDestination(settingsPath, path.join(hooksDir, 'pre-write-guardian-validate.js'), WRITE_MATCHER),
    ...createCrusherScriptCopyOperations(remap, targetRoot),
    createCrusherHookMergeOperationForDestination(settingsPath, path.join(hooksDir, 'crusher-hook.js'), SHELL_MATCHER),
  ];
  return [
    ...gates,
    ...createHostSessionHookOperations({
      createRemappedOperation: remap,
      targetRoot,
      hooksFilePath: settingsPath,
      sessionStartSourceRelativePath: DROID_SESSION_START_SOURCE_RELATIVE_PATH,
      plannedDestinations: new Set(gates.map(operation => operation.destinationPath)),
    }),
    ...createMeshNoticeScriptCopyOperations(remap, targetRoot, { withTeamSync: false }),
    createMeshNoticeHookMergeOperationForDestination(settingsPath, resolveMeshNoticeHookScriptDestination(targetRoot)),
  ];
}

function planDroidOperations(input, adapter) {
  const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
  const moduleOperations = modules.flatMap(module => (Array.isArray(module.paths) ? module.paths : [])
    .filter(sourceRelativePath => !isForeignPlatformPath(sourceRelativePath, adapter.target))
    .map(sourceRelativePath => planDroidPath(adapter, module, sourceRelativePath, planningInput, targetRoot)));
  return [...moduleOperations, ...createDroidHookOperations(adapter, targetRoot)];
}

module.exports = createInstallTargetAdapter({
  id: 'droid-home',
  target: 'droid',
  kind: 'home',
  rootSegments: ['.factory'],
  installStatePathSegments: ['egc', 'install-state.json'],
  planOperations: planDroidOperations,
});
