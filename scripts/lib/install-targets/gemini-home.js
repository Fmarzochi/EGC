const os = require('node:os');
const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  resolveModulesPlan,
} = require('./helpers');
const {
  createGlobalGateGuardHookMergeOperation,
  createGlobalCrusherHookMergeOperation,
  createGlobalBashGuardianHookMergeOperation,
  createGlobalMeshNoticeHookMergeOperation,
} = require('../antigravity-settings-hooks');
const {
  createGateGuardScriptCopyOperations,
  createCrusherScriptCopyOperations,
  createBashGuardianScriptCopyOperations,
  createMeshNoticeScriptCopyOperations,
} = require('../claude-settings-hooks');

const GEMINI_EGC_NAMESPACE = 'egc';
const AGY_SKILLS_SUBDIR = 'antigravity-cli/skills';

// Antigravity shares this home root (~/.gemini) for skill discovery (see
// AGY_SKILLS_SUBDIR above) but reads its own hooks.json at
// ~/.gemini/antigravity-cli/hooks.json, distinct from Gemini CLI's
// ~/.gemini/hooks/hooks.json -- so Gemini CLI's existing GateGuard wiring
// does not automatically cover Antigravity and needs this separate merge.
// scripts/hooks/gateguard-fact-force.js normally also arrives at this
// target via the hooks-runtime module's own scaffold (paths: scripts/hooks,
// scripts/lib) -- but hooks-runtime is only a DEFAULT base module for the
// 'egc' target's legacy profile, not something every install is guaranteed
// to select (a minimal/custom module selection can omit it). Copying the
// script explicitly here, unconditional of module selection, closes that
// gap: cubic-dev-ai review (PR #1052, 2026-07-27) found a minimal install
// could register this hooks.json entry while the script it points at was
// never actually copied anywhere, so every Antigravity Bash/Edit/Write call
// would try to launch a nonexistent file.
function createAntigravityGlobalGateGuardOperations(targetRoot, homeDir, createRemap) {
  const scriptCopyOperations = createGateGuardScriptCopyOperations(createRemap, targetRoot);
  const mergeOperations = ['Edit', 'Write', 'MultiEdit', 'Bash'].map(matcher => (
    createGlobalGateGuardHookMergeOperation(targetRoot, homeDir, matcher)
  ));
  return [...scriptCopyOperations, ...mergeOperations];
}

// Token Crusher: same reasoning as GateGuard above -- copy the standalone
// crusher hook + its deps explicitly (needed for minimal installs that skip
// hooks-runtime), then register it on Bash only (the Crusher compresses
// shell output, it does not touch file writes). Antigravity's PROJECT-level
// registration (.agents/hooks.json, antigravity-project.js) already had this;
// the GLOBAL registration (this file, ~/.gemini/antigravity-cli/hooks.json)
// did not, so a user who only installs the `egc` target (not `antigravity`)
// never got Crusher compression on Antigravity's global-scope Bash calls.
function createAntigravityGlobalCrusherOperations(targetRoot, homeDir, createRemap) {
  const scriptCopyOperations = createCrusherScriptCopyOperations(createRemap, targetRoot);
  return [
    ...scriptCopyOperations,
    createGlobalCrusherHookMergeOperation(targetRoot, homeDir, 'Bash'),
  ];
}

// EGC Guardian: same reasoning as GateGuard above -- copy
// pre-bash-guardian-validate.js (and its guardian-bin.js/shell-split.js
// deps) explicitly rather than relying on hooks-runtime having scaffolded
// them, then register it on Bash only (the Guardian validates shell
// commands, not file writes). cubic-dev-ai review (PR #1052, 2026-07-27)
// first found createGlobalBashGuardianHookMergeOperation was added to
// antigravity-settings-hooks.js but never actually called anywhere, then
// (once wired) found the same missing-script-copy gap GateGuard had.
// Session-mesh wake-signal notice: same reasoning as the three above -- copy
// the standalone mesh-events-inject.js explicitly (it is dependency-free, so
// one copy suffices) and register it on UserPromptSubmit at Antigravity's
// global hooks file, giving every Antigravity session the native
// turn-boundary wake signal even when only the `egc` target is installed.
function createAntigravityGlobalMeshNoticeOperations(targetRoot, homeDir, createRemap) {
  const scriptCopyOperations = createMeshNoticeScriptCopyOperations(createRemap, targetRoot);
  return [
    ...scriptCopyOperations,
    createGlobalMeshNoticeHookMergeOperation(targetRoot, homeDir),
  ];
}

function createAntigravityGlobalGuardianOperations(targetRoot, homeDir, createRemap) {
  const scriptCopyOperations = createBashGuardianScriptCopyOperations(createRemap, targetRoot);
  return [
    ...scriptCopyOperations,
    createGlobalBashGuardianHookMergeOperation(targetRoot, homeDir, 'Bash'),
  ];
}

// The GateGuard/Guardian script copies above are unconditional (needed for
// minimal installs that skip the hooks-runtime module, see the comments on
// those two functions), but a default install DOES select hooks-runtime,
// which independently scaffolds the whole scripts/hooks and scripts/lib
// directories via the generic module-path flow below -- as ONE 'copy-path'
// operation per directory (sourceRelativePath exactly 'scripts/hooks' or
// 'scripts/lib'), not one per file. That directory-level copy already
// includes every file the explicit ones also copy, so without this a
// default install recorded a redundant second copy of the same bytes to
// the same destination for each script (wasteful I/O, duplicate bookkeeping
// in the install state) per cubic-dev-ai review (PR #1052, 2026-07-27).
//
// Deliberately scoped to SOURCE paths under exactly these two directories,
// not a generic "any copy-path nested under any other copy-path" rule: an
// earlier version of this function compared DESTINATION paths across the
// whole operations list, which also caught unrelated --with/skills/rules
// operations that happened to land under a shared parent directory from a
// completely different module and dropped them too (a real regression --
// e.g. a --with-selected skill file nested under a skills/ directory
// operation from another module). Only a source path that is an actual
// descendant of one of these two known, hardcoded directories can ever be
// redundant with them.
const HOOKS_RUNTIME_DIRECTORY_SOURCES = ['scripts/hooks', 'scripts/lib'];

function dedupeCopyOperations(operations) {
  const presentDirectorySources = new Set(
    operations
      .filter(operation => (
        operation.kind === 'copy-path' && HOOKS_RUNTIME_DIRECTORY_SOURCES.includes(operation.sourceRelativePath)
      ))
      .map(operation => operation.sourceRelativePath)
  );

  return operations.filter(operation => {
    if (operation.kind !== 'copy-path') return true;
    return ![...presentDirectorySources].some(directorySource => (
      operation.sourceRelativePath !== directorySource
      && operation.sourceRelativePath.startsWith(`${directorySource}/`)
    ));
  });
}

function getGeminiManagedDestinationPath(adapter, sourceRelativePath, input) {
  const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
  const targetRoot = adapter.resolveRoot(input);

  if (normalizedSourcePath === 'rules') {
    return path.join(targetRoot, 'rules', GEMINI_EGC_NAMESPACE);
  }

  if (normalizedSourcePath.startsWith('rules/')) {
    return path.join(
      targetRoot,
      'rules',
      GEMINI_EGC_NAMESPACE,
      normalizedSourcePath.slice('rules/'.length)
    );
  }

  if (normalizedSourcePath === 'skills') {
    return path.join(targetRoot, 'skills', GEMINI_EGC_NAMESPACE);
  }

  if (normalizedSourcePath.startsWith('skills/')) {
    // Source layout in the repo is `skills/<category>/<skillName>[/<file>]`.
    // The Gemini-home install contract exposes a flat skill namespace
    // (`skills/<namespace>/<skillName>[/<file>]`) so consumers don't depend
    // on the repo's category taxonomy. Strip exactly the leading category
    // segment when present; leave already-flat paths untouched.
    const parts = normalizedSourcePath.slice('skills/'.length).split('/');
    const flatRemainder = parts.length >= 2 ? parts.slice(1).join('/') : parts.join('/');
    return path.join(targetRoot, 'skills', GEMINI_EGC_NAMESPACE, flatRemainder);
  }

  return null;
}

function getAGYManagedDestinationPath(adapter, sourceRelativePath, input) {
  const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
  const targetRoot = adapter.resolveRoot(input);

  if (normalizedSourcePath.startsWith('skills/')) {
    // AGY reads skills from ~/.gemini/antigravity-cli/skills/<skillName>/
    // Mirror the same category-stripping logic as the egc namespace path.
    const parts = normalizedSourcePath.slice('skills/'.length).split('/');
    const flatRemainder = parts.length >= 2 ? parts.slice(1).join('/') : parts.join('/');
    return path.join(targetRoot, AGY_SKILLS_SUBDIR, flatRemainder);
  }

  return null;
}

module.exports = createInstallTargetAdapter({
  id: 'egc-home',
  target: 'egc',
  kind: 'home',
  rootSegments: ['.gemini'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.gemini-plugin',
  planOperations(input, adapter) {
    const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
    const homeDir = input.homeDir || os.homedir();

    const moduleOperations = modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(p => !isForeignPlatformPath(p, adapter.target))
        .flatMap(sourceRelativePath => {
          const ops = [];

          const managedDestinationPath = getGeminiManagedDestinationPath(
            adapter,
            sourceRelativePath,
            planningInput
          );

          if (managedDestinationPath) {
            ops.push(createRemappedOperation(
              adapter,
              module.id,
              sourceRelativePath,
              managedDestinationPath,
              { strategy: 'preserve-relative-path' }
            ));
          } else {
            ops.push(adapter.createScaffoldOperation(module.id, sourceRelativePath, planningInput));
          }

          const agyDestinationPath = getAGYManagedDestinationPath(
            adapter,
            sourceRelativePath,
            planningInput
          );

          if (agyDestinationPath) {
            ops.push(createRemappedOperation(
              adapter,
              module.id,
              sourceRelativePath,
              agyDestinationPath,
              { strategy: 'preserve-relative-path' }
            ));
          }

          return ops;
        });
    });

    const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
      createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
    );

    // Deterministic: every egc-home install also registers the GateGuard
    // fact-forcing gate for Antigravity's global hooks.json, even when no
    // content modules are selected.
    return dedupeCopyOperations([
      ...moduleOperations,
      ...createAntigravityGlobalGateGuardOperations(targetRoot, homeDir, remap),
      ...createAntigravityGlobalCrusherOperations(targetRoot, homeDir, remap),
      ...createAntigravityGlobalGuardianOperations(targetRoot, homeDir, remap),
      ...createAntigravityGlobalMeshNoticeOperations(targetRoot, homeDir, remap),
    ]);
  },
});
