const os = require('node:os');
const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
} = require('./helpers');
const {
  createGlobalGateGuardHookMergeOperation,
} = require('../antigravity-settings-hooks');

const GEMINI_EGC_NAMESPACE = 'egc';
const AGY_SKILLS_SUBDIR = 'antigravity-cli/skills';

// Antigravity shares this home root (~/.gemini) for skill discovery (see
// AGY_SKILLS_SUBDIR above) but reads its own hooks.json at
// ~/.gemini/antigravity-cli/hooks.json, distinct from Gemini CLI's
// ~/.gemini/hooks/hooks.json -- so Gemini CLI's existing GateGuard wiring
// does not automatically cover Antigravity and needs this separate merge.
// scripts/hooks/gateguard-fact-force.js is already scaffolded at
// resolveGateGuardHookScriptDestination(targetRoot) for this target via the
// hooks-runtime module (paths: scripts/hooks, scripts/lib), so this only
// adds the hooks.json registration.
function createAntigravityGlobalGateGuardOperations(targetRoot, homeDir) {
  return ['Edit', 'Write', 'MultiEdit', 'Bash'].map(matcher => (
    createGlobalGateGuardHookMergeOperation(targetRoot, homeDir, matcher)
  ));
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
    let modules;
    if (Array.isArray(input.modules)) {
      modules = input.modules;
    } else if (input.module) {
      modules = [input.module];
    } else {
      modules = [];
    }
    const planningInput = {
      repoRoot: input.repoRoot,
      projectRoot: input.projectRoot,
      homeDir: input.homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);
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

    // Deterministic: every egc-home install also registers the GateGuard
    // fact-forcing gate for Antigravity's global hooks.json, even when no
    // content modules are selected.
    return [
      ...moduleOperations,
      ...createAntigravityGlobalGateGuardOperations(targetRoot, homeDir),
    ];
  },
});
