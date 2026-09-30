const {
  buildValidationIssue,
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  createWindsurfGateGuardOperations,
} = require('../windsurf-gateguard-operations');
const {
  devinConfigIssues,
  resolveDevinUserConfigPath,
  resolveDevinUserConfigRoot,
} = require('../devin-local-hooks');

module.exports = createInstallTargetAdapter({
  id: 'windsurf-home',
  target: 'windsurf',
  kind: 'home',
  rootSegments: ['.codeium', 'windsurf'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.codeium/windsurf',
  // The skills and the hook scripts land under ~/.codeium/windsurf, while the
  // Devin Local hooks that run those scripts live in the Devin user config
  // (~/.config/devin, %APPDATA%\devin on Windows): the install owns both roots.
  resolveManagedRoots(input, adapter) {
    return [adapter.resolveRoot(input), resolveDevinUserConfigRoot(input.homeDir)];
  },
  validateMore(input) {
    return devinConfigIssues(resolveDevinUserConfigPath(input.homeDir), buildValidationIssue);
  },
  planOperations(input, adapter) {
    const planningInput = {
      repoRoot: input.repoRoot,
      projectRoot: input.projectRoot,
      homeDir: input.homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

    return [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createWindsurfGateGuardOperations(
        adapter,
        targetRoot,
        createRemappedOperation,
        resolveDevinUserConfigPath(input.homeDir)
      ),
    ];
  },
});
