const path = require('node:path');

const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  createAdapterStdinJsonCopyOperation,
  createBashGuardianHookMergeOperationForDestination,
  createBashGuardianScriptCopyOperations,
  createCrusherHookMergeOperationForDestination,
  createCrusherScriptCopyOperations,
} = require('../claude-settings-hooks');

// Junie CLI hooks ONLY work from the home-scope config by default --
// confirmed against junie.jetbrains.com/docs/junie-cli-hooks.html:
// "Project-local hooks from <project-root>/.junie/config.json are ignored
// by default for safety. If you intentionally want to run hooks from a
// project file, pass that file explicitly with --config-location." So
// Guardian/Crusher are wired here (kind: 'home', ~/.junie/config.json),
// mirroring the established kiro-home.js/kiro-project.js split, INCLUDING
// its choice to also scaffold skills here (not just junie-project.js):
// getInstallTargetAdapter('junie') resolves to this file first (registered
// ahead of junie-project.js in registry.js's ADAPTERS array, same ordering
// kiro-home/kiro-project already use), and the top-level CLI's --target
// flag only accepts the bare 'junie' string, never 'junie-project' --
// confirmed empirically. Without the skill scaffold here too, a plain
// `egc install --target junie --profile full` would install Guardian and
// Crusher but silently stop installing skills, a real regression from
// today's behavior.
//
// config.json's own JSON structure is the exact same
// {hooks: {PreToolUse: [{matcher, hooks: [{type, command}]}]}} shape as
// Claude Code's settings.json -- confirmed the same way -- but the
// filename differs (config.json, not settings.json), so this uses the
// destination-driven merge builders (same pattern as Trae, PR #1079) rather
// than the plain targetRoot-driven ones (which assume settings.json).
//
// The response ENVELOPE a hook script must print is NOT the same as Claude
// Code's, though: Junie expects a flat {decision, reason, updatedInput}
// object, not {hookSpecificOutput: {permissionDecision, updatedInput}} --
// confirmed the same way. That mismatch is why this wires dedicated
// translation adapters (junie-guardian-adapter.js, junie-crusher-adapter.js)
// instead of the shared pre-bash-guardian-validate.js/crusher-hook.js
// scripts directly, the same reasoning Cursor's beforeShellExecution
// adapter already established for a different contract mismatch.
function resolveJunieConfigJsonPath(targetRoot) {
  return path.join(targetRoot, 'config.json');
}

function createJunieGuardianOperations(adapter, targetRoot) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  const adapterModuleId = 'egc-junie-guardian-hook';
  const adapterScriptDestination = path.join(targetRoot, 'scripts', 'hooks', 'junie-guardian-adapter.js');

  return [
    ...createBashGuardianScriptCopyOperations(remap, targetRoot),
    remap(adapterModuleId, 'scripts/hooks/junie-guardian-adapter.js', adapterScriptDestination, { strategy: 'preserve-relative-path' }),
    createAdapterStdinJsonCopyOperation(remap, targetRoot),
    createBashGuardianHookMergeOperationForDestination(
      resolveJunieConfigJsonPath(targetRoot),
      adapterScriptDestination,
      'Bash'
    ),
  ];
}

function createJunieCrusherOperations(adapter, targetRoot) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  const adapterModuleId = 'egc-junie-crusher-hook';
  const adapterScriptDestination = path.join(targetRoot, 'scripts', 'hooks', 'junie-crusher-adapter.js');

  return [
    ...createCrusherScriptCopyOperations(remap, targetRoot),
    remap(adapterModuleId, 'scripts/hooks/junie-crusher-adapter.js', adapterScriptDestination, { strategy: 'preserve-relative-path' }),
    createCrusherHookMergeOperationForDestination(
      resolveJunieConfigJsonPath(targetRoot),
      adapterScriptDestination,
      'Bash'
    ),
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'junie-home',
  target: 'junie',
  kind: 'home',
  rootSegments: ['.junie'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.junie',
  planOperations(input, adapter) {
    const planningInput = { repoRoot: input.repoRoot, projectRoot: input.projectRoot, homeDir: input.homeDir };
    const targetRoot = adapter.resolveRoot(planningInput);
    return [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createJunieGuardianOperations(adapter, targetRoot),
      ...createJunieCrusherOperations(adapter, targetRoot),
    ];
  },
});
