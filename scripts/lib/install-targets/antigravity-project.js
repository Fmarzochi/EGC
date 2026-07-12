const path = require('path');

const {
  createFlatRuleOperations,
  createInstallTargetAdapter,
  createManagedScaffoldOperation,
  createRemappedOperation,
  normalizeRelativePath,
} = require('./helpers');
const {
  GATEGUARD_HOOK_MODULE_ID,
  GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  resolveGateGuardHookScriptDestination,
} = require('../claude-settings-hooks');
const {
  createProjectGateGuardHookMergeOperation,
} = require('../antigravity-settings-hooks');

const SUPPORTED_SOURCE_PREFIXES = ['rules', 'commands', 'agents', 'skills', '.agents', 'AGENTS.md'];
const UTILS_SOURCE_RELATIVE_PATH = 'scripts/lib/utils.js';

function supportsAntigravitySourcePath(sourceRelativePath) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);
  return SUPPORTED_SOURCE_PREFIXES.some(prefix => (
    normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  ));
}

function resolveUtilsScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'lib', 'utils.js');
}

// gateguard-fact-force.js requires '../lib/utils' at load time, so both
// files are scaffolded together under this adapter's own root (.agents/)
// before the .agents/hooks.json merge points a command at either of them.
// 'scripts/**' is outside SUPPORTED_SOURCE_PREFIXES above (Antigravity's
// module content is rules/commands/agents/skills, not raw scripts), so this
// is scaffolded directly rather than through the module path filter.
function createGateGuardOperations(adapter, targetRoot, projectRoot) {
  const scriptOperation = createRemappedOperation(
    adapter,
    GATEGUARD_HOOK_MODULE_ID,
    GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    resolveGateGuardHookScriptDestination(targetRoot),
    { strategy: 'preserve-relative-path' }
  );
  const utilsOperation = createRemappedOperation(
    adapter,
    GATEGUARD_HOOK_MODULE_ID,
    UTILS_SOURCE_RELATIVE_PATH,
    resolveUtilsScriptDestination(targetRoot),
    { strategy: 'preserve-relative-path' }
  );

  return [
    scriptOperation,
    utilsOperation,
    createProjectGateGuardHookMergeOperation(targetRoot, projectRoot, 'Edit'),
    createProjectGateGuardHookMergeOperation(targetRoot, projectRoot, 'Write'),
    createProjectGateGuardHookMergeOperation(targetRoot, projectRoot, 'MultiEdit'),
    createProjectGateGuardHookMergeOperation(targetRoot, projectRoot, 'Bash'),
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'antigravity-project',
  target: 'antigravity',
  kind: 'project',
  rootSegments: ['.agents'],
  installStatePathSegments: ['egc-install-state.json'],
  supportsModule(module) {
    const paths = Array.isArray(module && module.paths) ? module.paths : [];
    return paths.length > 0;
  },
  planOperations(input, adapter) {
    const modules = Array.isArray(input.modules)
      ? input.modules
      : (input.module ? [input.module] : []);
    const {
      repoRoot,
      projectRoot,
      homeDir,
    } = input;
    const planningInput = {
      repoRoot,
      projectRoot,
      homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

    const moduleOperations = modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(supportsAntigravitySourcePath)
        .flatMap(sourceRelativePath => {
          const normalizedPath = normalizeRelativePath(sourceRelativePath);

          if (sourceRelativePath === 'rules') {
            return createFlatRuleOperations({
              moduleId: module.id,
              repoRoot,
              sourceRelativePath,
              destinationDir: path.join(targetRoot, 'rules'),
            });
          }

          if (sourceRelativePath === 'commands') {
            return [
              createManagedScaffoldOperation(
                module.id,
                sourceRelativePath,
                path.join(targetRoot, 'workflows'),
                'preserve-relative-path'
              ),
            ];
          }

          if (sourceRelativePath === 'agents') {
            return [
              createManagedScaffoldOperation(
                module.id,
                sourceRelativePath,
                path.join(targetRoot, 'skills'),
                'preserve-relative-path'
              ),
            ];
          }

          // AGY discovers project skills at .agent/skills/<name>/ (flat).
          // Strip the leading category segment so repo layout does not leak
          // into the discovery path.
          if (normalizedPath.startsWith('skills/')) {
            const parts = normalizedPath.slice('skills/'.length).split('/');
            const flatRemainder = parts.length >= 2 ? parts.slice(1).join('/') : parts.join('/');
            return [
              createRemappedOperation(
                adapter,
                module.id,
                sourceRelativePath,
                path.join(targetRoot, 'skills', flatRemainder),
                { strategy: 'preserve-relative-path' }
              ),
            ];
          }

          return [adapter.createScaffoldOperation(module.id, sourceRelativePath, planningInput)];
        });
    });

    // Deterministic: every Antigravity install registers the GateGuard
    // fact-forcing gate, even when no content modules are selected,
    // mirroring Claude Code's always-on hook registration.
    return [
      ...moduleOperations,
      ...createGateGuardOperations(adapter, targetRoot, projectRoot),
    ];
  },
});
