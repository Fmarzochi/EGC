const os = require('node:os');
const path = require('node:path');

const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  GATEGUARD_HOOK_MODULE_ID,
  GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  resolveGateGuardHookScriptDestination,
} = require('../claude-settings-hooks');
const {
  createPreToolUseGateGuardHookMergeOperation,
} = require('../copilot-settings-hooks');

const UTILS_SOURCE_RELATIVE_PATH = 'scripts/lib/utils.js';

function resolveUtilsScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'lib', 'utils.js');
}

function createGateGuardOperations(adapter, targetRoot, homeDir) {
  // gateguard-fact-force.js requires '../lib/utils' at load time, so both
  // files must be scaffolded together under the adapter's own root before
  // the hooks.json merge (which lives at the VS Code-mandated ~/.copilot/
  // hooks path, not under ~/.github) can point a command at either of them.
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
    createPreToolUseGateGuardHookMergeOperation(targetRoot, homeDir, 'Edit'),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, homeDir, 'Write'),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, homeDir, 'MultiEdit'),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, homeDir, 'Bash'),
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'copilot-home',
  target: 'copilot',
  kind: 'home',
  rootSegments: ['.github'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.github',
  planOperations(input, adapter) {
    const moduleOperations = createFlatSkillPlanOperations(input, adapter);
    const planningInput = {
      repoRoot: input.repoRoot,
      projectRoot: input.projectRoot,
      homeDir: input.homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);
    const homeDir = input.homeDir || os.homedir();

    // Deterministic: every Copilot install registers the GateGuard
    // fact-forcing gate, even when no content modules are selected, mirroring
    // Claude Code's always-on hook registration.
    return [
      ...moduleOperations,
      ...createGateGuardOperations(adapter, targetRoot, homeDir),
    ];
  },
});
