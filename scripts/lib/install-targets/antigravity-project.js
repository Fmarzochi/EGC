const path = require('node:path');

const {
  createFlatRuleOperations,
  createInstallTargetAdapter,
  createManagedScaffoldOperation,
  createRemappedOperation,
  normalizeRelativePath,
  planFlatSkillOperation,
} = require('./helpers');
const {
  GATEGUARD_HOOK_MODULE_ID,
  GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  resolveGateGuardHookScriptDestination,
  createCrusherScriptCopyOperations,
} = require('../claude-settings-hooks');
const {
  createProjectGateGuardHookMergeOperation,
  createProjectCrusherHookMergeOperation,
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
    // Token Crusher: same hooks.json shape, scaffold the hook + deps under the
    // adapter root and register it on Bash at .agents/hooks.json.
    ...createCrusherScriptCopyOperations(
      (moduleId, sourceRelativePath, destinationPath, options) => (
        createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
      ),
      targetRoot
    ),
    createProjectCrusherHookMergeOperation(targetRoot, projectRoot, 'Bash'),
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'antigravity-project',
  target: 'antigravity',
  kind: 'project',
  rootSegments: ['.agents'],
  installStatePathSegments: ['egc-install-state.json'],
  supportsModule(module) {
    const paths = Array.isArray(module?.paths) ? module.paths : [];
    return paths.length > 0;
  },
  planOperations(input, adapter) {
    let modules;
    if (Array.isArray(input.modules)) {
      modules = input.modules;
    } else if (input.module) {
      modules = [input.module];
    } else {
      modules = [];
    }
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

          // AGY discovers project skills at .agent/skills/<name>/ (flat);
          // planFlatSkillOperation strips the leading category segment for
          // skills/** paths and scaffolds everything else as-is.
          return [planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot)];
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
