const {
  buildValidationIssue,
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const { createHostSessionHookOperations } = require('../claude-settings-hooks');
const {
  createWindsurfGateGuardOperations,
} = require('../windsurf-gateguard-operations');
const {
  devinConfigIssues,
  resolveDevinUserConfigPath,
  resolveDevinUserConfigRoot,
} = require('../devin-local-hooks');

// The session hooks, in the same user config and the same Claude Code
// format ([Devin lifecycle hooks](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks),
// read on 2026-11-28): SessionStart gets session_id and source, names no
// directory and sets DEVIN_PROJECT_DIR for the hook, and reads
// hookSpecificOutput.additionalContext back, so the project memory reaches
// the session and the Team Brain is pulled when the team asks for it; Stop
// pushes what changed. The user config alone gets them: Devin reads it in
// every project, and the project config would run the same two hooks
// twice.
const DEVIN_SESSION_START_SOURCE_RELATIVE_PATH = 'scripts/hooks/devin-session-start.js';

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
    const devinConfigPath = resolveDevinUserConfigPath(input.homeDir);

    const planned = [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createWindsurfGateGuardOperations(adapter, targetRoot, createRemappedOperation, devinConfigPath),
    ];
    return [
      ...planned,
      ...createHostSessionHookOperations({
        createRemappedOperation: (moduleId, sourceRelativePath, destinationPath, options) => (
          createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
        ),
        targetRoot,
        hooksFilePath: devinConfigPath,
        sessionStartSourceRelativePath: DEVIN_SESSION_START_SOURCE_RELATIVE_PATH,
        plannedDestinations: new Set(planned.map(operation => operation.destinationPath)),
      }),
    ];
  },
});
