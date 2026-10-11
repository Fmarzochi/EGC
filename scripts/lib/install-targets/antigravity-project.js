const path = require('node:path');

const {
  createFlatRuleOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
  normalizeModulesInput,
  normalizeRelativePath,
  planFlatSkillOperation,
} = require('./helpers');
const { CRUSHER_HOOK_MODULE_ID } = require('../claude-settings-hooks');
const { createAntigravityGuardianOperations } = require('../antigravity-guardian-operations');
const { createAntigravityGateGuardOperations, createAntigravityMeshNoticeOperations } = require('../antigravity-hook-operations');
const { resolveProjectHooksJsonPath } = require('../antigravity-guardian-hooks');
const { planAntigravityCopyOperations, readRecordedDestinations } = require('../antigravity-rules');
const { isAgentSource, planAntigravityAgentFiles } = require('../antigravity-agents');
const { dropCommandsShadowedBySkills, isCommandSource, planAntigravityCommandFiles } = require('../antigravity-commands');

const SUPPORTED_SOURCE_PREFIXES = ['rules', 'commands', 'agents', 'skills', '.agents', 'AGENTS.md'];

function supportsAntigravitySourcePath(sourceRelativePath) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);
  return SUPPORTED_SOURCE_PREFIXES.some(prefix => (
    normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  ));
}

// The hooks Antigravity runs are the named hooks in the project
// .agents/hooks.json, in its own format: egc-guardian
// (antigravity-guardian-operations.js), egc-gateguard and egc-mesh-notice
// (antigravity-hook-operations.js). Each comes with the scripts it runs,
// scaffolded under this adapter's own root (.agents/) before the hooks.json
// entry points a command at them: 'scripts/**' is outside
// SUPPORTED_SOURCE_PREFIXES above (Antigravity's module content is
// rules/commands/agents/skills, not raw scripts), so they are scaffolded
// directly rather than through the module path filter. The Claude-format
// entries once written beside them (a `hooks` key with Bash and Edit
// matchers, which name no Antigravity tool, and a UserPromptSubmit event
// Antigravity does not have) never fired; an upgrade retires them, since
// they left the plan. The Token Crusher keeps no hook here: an Antigravity
// hook answers a decision, never a rewritten command, so the `egc run` shim
// and the protocol are its path.
function createAntigravityHookOperations(adapter, targetRoot, projectRoot) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );
  const hooksJsonPath = resolveProjectHooksJsonPath(projectRoot);
  return [
    ...createAntigravityGuardianOperations(remap, targetRoot, hooksJsonPath),
    ...createAntigravityGateGuardOperations(remap, targetRoot, hooksJsonPath),
    ...createAntigravityMeshNoticeOperations(remap, targetRoot, hooksJsonPath),
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'antigravity-project',
  target: 'antigravity',
  kind: 'project',
  rootSegments: ['.agents'],
  installStatePathSegments: ['egc-install-state.json'],
  // The Token Crusher hook once written here never fired; an upgrade
  // retires what that module recorded (see createAntigravityHookOperations).
  retiredModuleIds: [CRUSHER_HOOK_MODULE_ID],
  supportsModule(module) {
    const paths = Array.isArray(module?.paths) ? module.paths : [];
    return paths.length > 0;
  },
  planOperations(input, adapter) {
    const modules = normalizeModulesInput(input);
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
    const recordedDestinations = readRecordedDestinations(adapter.getInstallStatePath(planningInput));

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

          if (isCommandSource(sourceRelativePath)) {
            return planAntigravityCopyOperations({
              adapter,
              moduleId: module.id,
              files: planAntigravityCommandFiles(repoRoot, sourceRelativePath),
              destinationDir: path.join(targetRoot, 'skills'),
              repoRoot: repoRoot || '',
              recordedDestinations,
            });
          }

          if (isAgentSource(sourceRelativePath)) {
            return planAntigravityCopyOperations({
              adapter,
              moduleId: module.id,
              files: planAntigravityAgentFiles(repoRoot, sourceRelativePath),
              destinationDir: path.join(targetRoot, 'agents'),
              repoRoot: repoRoot || '',
              recordedDestinations,
            });
          }

          // AGY discovers project skills at .agent/skills/<name>/ (flat);
          // planFlatSkillOperation strips the leading category segment for
          // skills/** paths and scaffolds everything else as-is.
          return [planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot)];
        });
    });

    // Deterministic: every Antigravity install registers the three named
    // hooks, even when no content modules are selected, mirroring Claude
    // Code's always-on hook registration.
    return [
      ...dropCommandsShadowedBySkills(moduleOperations),
      ...createAntigravityHookOperations(adapter, targetRoot, projectRoot),
    ];
  },
});
