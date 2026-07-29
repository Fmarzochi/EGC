const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
} = require('./helpers');
const {
  BASH_GUARDIAN_HOOK_MODULE_ID,
  BASH_GUARDIAN_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  CRUSHER_HOOK_MODULE_ID,
  CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  HOOK_OPERATION_KIND,
  PRE_TOOL_USE_EVENT,
  createBashGuardianScriptCopyOperations,
  createCrusherScriptCopyOperations,
} = require('../claude-settings-hooks');

// Trae reads the same {hooks: {PreToolUse: [{matcher, hooks: [{type,
// command}]}]}} JSON schema as Claude Code, including
// hookSpecificOutput.permissionDecision/updatedInput -- confirmed against
// docs.trae.ai/ide/hook-configuration-reference, which documents the config
// file at $PROJECT_FOLDER/.trae/hooks.json (project scope) and explicitly
// states Trae can import an existing Claude Code hook configuration. The
// shell/terminal tool's matcher is "RunCommand" (not "Bash" like Claude
// Code/Codex, not "Shell" like Cursor) -- confirmed the same way, not
// assumed from the other hosts' naming.
function resolveTraeRoot(adapter, input) {
  return adapter.resolveRoot(input);
}

function buildTraePreToolUseMergeOperation(traeRoot, moduleId, sourceRelativePath, hookScriptPath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId,
    sourceRelativePath,
    destinationPath: path.join(traeRoot, 'hooks.json'),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_TOOL_USE_EVENT,
    hookMatcher: 'RunCommand',
    hookScriptPath,
  };
}

// Every Trae install registers the Guardian Bash validator on
// PreToolUse/RunCommand, unconditionally -- the same "deterministic,
// regardless of selected modules" pattern every other host in this registry
// uses for its own security hooks, so a minimal install is never silently
// unprotected.
function createTraeGuardianOperations(adapter, traeRoot) {
  const hookScriptPath = path.join(traeRoot, 'scripts', 'hooks', 'pre-bash-guardian-validate.js');
  const copyOperations = createBashGuardianScriptCopyOperations(
    (moduleId, sourceRelativePath, destinationPath, options) => (
      createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
    ),
    traeRoot
  );

  const mergeOperation = buildTraePreToolUseMergeOperation(
    traeRoot,
    BASH_GUARDIAN_HOOK_MODULE_ID,
    BASH_GUARDIAN_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    hookScriptPath
  );

  return [...copyOperations, mergeOperation];
}

// Token Crusher for Trae: same PreToolUse/updatedInput rewrite mechanism as
// Claude Code and Codex, so the shared crusher-hook.js needs no host-specific
// translation adapter here (unlike Cursor, whose beforeShellExecution slot
// cannot rewrite a command -- see cursor-crusher-hooks.js).
function createTraeCrusherOperations(adapter, traeRoot) {
  const hookScriptPath = path.join(traeRoot, 'scripts', 'hooks', 'crusher-hook.js');
  const copyOperations = createCrusherScriptCopyOperations(
    (moduleId, sourceRelativePath, destinationPath, options) => (
      createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
    ),
    traeRoot
  );

  const mergeOperation = buildTraePreToolUseMergeOperation(
    traeRoot,
    CRUSHER_HOOK_MODULE_ID,
    CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    hookScriptPath
  );

  return [...copyOperations, mergeOperation];
}

module.exports = createInstallTargetAdapter({
  id: 'trae-project',
  target: 'trae',
  kind: 'project',
  rootSegments: ['.trae'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.trae',
  planOperations(input, adapter) {
    // Same default scaffold createInstallTargetAdapter() itself would use
    // when planOperations is omitted (this file's previous behavior) --
    // preserved verbatim here only because a custom planOperations is now
    // needed to also append the Guardian/Crusher operations below.
    let modules;
    if (Array.isArray(input.modules)) {
      modules = input.modules;
    } else if (input.module) {
      modules = [input.module];
    } else {
      modules = [];
    }

    const moduleOperations = modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(p => !isForeignPlatformPath(p, adapter.target))
        .map(sourceRelativePath => adapter.createScaffoldOperation(module.id, sourceRelativePath, input));
    });

    const traeRoot = resolveTraeRoot(adapter, input);
    return [
      ...moduleOperations,
      ...createTraeGuardianOperations(adapter, traeRoot),
      ...createTraeCrusherOperations(adapter, traeRoot),
    ];
  },
});
