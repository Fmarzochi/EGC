const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  GATEGUARD_HOOK_MODULE_ID,
  HOOK_OPERATION_KIND,
  createGateGuardScriptCopyOperations,
} = require('../claude-settings-hooks');
const {
  ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_RUN_COMMAND_EVENT,
  PRE_WRITE_CODE_EVENT,
  resolveAdapterScriptDestination,
  resolveHooksJsonPath,
} = require('../windsurf-gateguard-hooks');

// Windsurf Cascade Hooks (docs: https://docs.windsurf.com/windsurf/cascade/hooks,
// redirects to https://docs.devin.ai/desktop/cascade/hooks) reads
// ~/.codeium/windsurf/hooks.json for Devin Desktop, which is exactly this
// adapter's own root (rootSegments below). pre_write_code and
// pre_run_command are real pre-action hooks that can block by exiting 2, but
// they use a different stdin/exit-code contract than Claude Code's, so the
// gate runs through scripts/hooks/windsurf-gateguard-adapter.js instead of
// gateguard-fact-force.js's own CLI entrypoint directly.
function createWindsurfGateGuardOperations(adapter, targetRoot) {
  const scriptCopyOperations = createGateGuardScriptCopyOperations(
    (moduleId, sourceRelativePath, destinationPath, options) => (
      createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
    ),
    targetRoot
  );

  const adapterScriptDestination = resolveAdapterScriptDestination(targetRoot);
  const adapterCopyOperation = createRemappedOperation(
    adapter,
    GATEGUARD_HOOK_MODULE_ID,
    ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    adapterScriptDestination,
    { strategy: 'preserve-relative-path' }
  );

  const hooksJsonPath = resolveHooksJsonPath(targetRoot);
  const mergeOperations = [PRE_WRITE_CODE_EVENT, PRE_RUN_COMMAND_EVENT].map(event => ({
    kind: HOOK_OPERATION_KIND,
    moduleId: GATEGUARD_HOOK_MODULE_ID,
    sourceRelativePath: ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: hooksJsonPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: event,
    hookScriptPath: adapterScriptDestination,
  }));

  return [...scriptCopyOperations, adapterCopyOperation, ...mergeOperations];
}

module.exports = createInstallTargetAdapter({
  id: 'windsurf-home',
  target: 'windsurf',
  kind: 'home',
  rootSegments: ['.codeium', 'windsurf'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.codeium/windsurf',
  planOperations(input, adapter) {
    const planningInput = {
      repoRoot: input.repoRoot,
      projectRoot: input.projectRoot,
      homeDir: input.homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

    return [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createWindsurfGateGuardOperations(adapter, targetRoot),
    ];
  },
});
