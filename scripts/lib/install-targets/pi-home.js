'use strict';

const path = require('node:path');

const {
  createFlatFileOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  planFlatSkillOperation,
  resolveModulesPlan,
} = require('./helpers');
const { resolvePiAgentDir } = require('../pi-paths');

const EXTENSION_SOURCE_RELATIVE_PATH = 'scripts/hooks/pi-egc-extension.js';
const LIBRARY_FAMILIES = new Set(['agents', 'rules']);
const LIBRARY_ROOT_SEGMENTS = ['egc', 'library'];

function resolvePiExtensionDestination(targetRoot) {
  return path.join(targetRoot, 'extensions', 'egc-guardian.js');
}

function planPiCommands(adapter, module, sourceRelativePath, repoRoot, targetRoot) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);
  if (normalizedPath === 'commands') {
    return createFlatFileOperations({ moduleId: module.id, repoRoot, sourceRelativePath, destinationDir: path.join(targetRoot, 'prompts') });
  }
  return [createRemappedOperation(adapter, module.id, sourceRelativePath, path.join(targetRoot, 'prompts', path.posix.basename(normalizedPath)), {
    strategy: 'preserve-relative-path',
  })];
}

function planPiPath(adapter, module, sourceRelativePath, planningInput, targetRoot) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);
  const family = normalizedPath.split('/')[0];
  if (family === 'commands') return planPiCommands(adapter, module, sourceRelativePath, planningInput.repoRoot, targetRoot);
  if (LIBRARY_FAMILIES.has(family)) {
    return [createRemappedOperation(adapter, module.id, sourceRelativePath, path.join(targetRoot, ...LIBRARY_ROOT_SEGMENTS, ...normalizedPath.split('/')), {
      strategy: 'preserve-relative-path',
    })];
  }
  return [planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot)];
}

// The extension and what it loads: the gates it has always run on
// tool_call, and, since the session work moved into it ([pi extensions](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md),
// read on 2026-11-28: before_agent_start may return a message pi keeps in
// the session, agent_end and session_shutdown run after a run and before
// the runtime goes down), the session runtime of the other hosts and the
// shared mesh notice script, copied with their paths kept under the agent
// directory, the files the gates already plant left to them.
function createPiExtensionOperations(adapter, targetRoot, plannedDestinations) {
  const {
    BASH_GUARDIAN_HOOK_MODULE_ID,
    createBashGuardianScriptCopyOperations,
    createCrusherScriptCopyOperations,
    createMeshNoticeScriptCopyOperations,
    createSessionRuntimeCopyOperations,
    createWriteValidatorScriptCopyOperation,
  } = require('../claude-settings-hooks');
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );
  const gates = [
    ...createBashGuardianScriptCopyOperations(remap, targetRoot),
    createWriteValidatorScriptCopyOperation(remap, targetRoot),
    ...createCrusherScriptCopyOperations(remap, targetRoot),
    remap(BASH_GUARDIAN_HOOK_MODULE_ID, EXTENSION_SOURCE_RELATIVE_PATH, resolvePiExtensionDestination(targetRoot), { strategy: 'preserve-relative-path' }),
  ];
  const planned = new Set([...plannedDestinations, ...gates.map(operation => operation.destinationPath)]);
  return [
    ...gates,
    ...createSessionRuntimeCopyOperations(remap, targetRoot, planned),
    ...createMeshNoticeScriptCopyOperations(remap, targetRoot, { withTeamSync: false }),
  ];
}

function planPiOperations(input, adapter) {
  const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
  const moduleOperations = modules.flatMap(module => (Array.isArray(module.paths) ? module.paths : [])
    .filter(sourceRelativePath => !isForeignPlatformPath(sourceRelativePath, adapter.target))
    .flatMap(sourceRelativePath => planPiPath(adapter, module, sourceRelativePath, planningInput, targetRoot)));
  return [...moduleOperations, ...createPiExtensionOperations(adapter, targetRoot, new Set(moduleOperations.map(operation => operation.destinationPath)))];
}

const baseAdapter = createInstallTargetAdapter({
  id: 'pi-home',
  target: 'pi',
  kind: 'home',
  resolveRoot(input = {}) {
    return resolvePiAgentDir(input);
  },
  installStatePathSegments: ['egc', 'install-state.json'],
  planOperations: planPiOperations,
});

module.exports = Object.freeze({ ...baseAdapter, resolvePiAgentDir });
