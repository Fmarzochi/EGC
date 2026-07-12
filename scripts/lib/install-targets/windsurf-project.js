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

// See windsurf-home.js for the hook contract details. This adapter's own
// root (.windsurf/) is Windsurf's documented workspace-level hooks.json
// location, merged together with the user-level file at hook-execution time.
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
  id: 'windsurf-project',
  target: 'windsurf',
  kind: 'project',
  rootSegments: ['.windsurf'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.windsurf',
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
