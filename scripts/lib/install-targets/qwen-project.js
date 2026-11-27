const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
} = require('./helpers');
const {
  createBashGuardianScriptCopyOperations,
  createCrusherScriptCopyOperations,
  createHostSessionHookOperations,
  createPreToolUseBashGuardianHookMergeOperation,
  createPreToolUseCrusherHookMergeOperation,
  resolveSettingsPath,
} = require('../claude-settings-hooks');

// Qwen Code discovers project skills from .qwen/skills/<skill-name>/SKILL.md.
//
// Its hook config is a near-literal copy of Claude Code's own contract --
// confirmed against github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md,
// down to hookSpecificOutput.permissionDecision/updatedInput and even a
// residual doc line referring to "Claude" instead of "Qwen" (the event
// table's Stop row). Config lives at .qwen/settings.json -- the exact same
// {hooks: {PreToolUse: [{matcher, hooks: [{type, command}]}]}} shape and
// filename Claude Code itself uses -- so this reuses the generic
// createPreToolUseBashGuardianHookMergeOperation/createPreToolUseCrusherHookMergeOperation
// builders directly (targetRoot-driven, no destination override needed,
// unlike Trae/Copilot/Antigravity). The shell tool's matcher is
// "run_shell_command" (not "Bash"/"Shell"/"RunCommand") -- confirmed the
// same way, not assumed from the other hosts' naming.
function createQwenGuardianOperations(adapter, targetRoot) {
  const copyOperations = createBashGuardianScriptCopyOperations(
    (moduleId, sourceRelativePath, destinationPath, options) => (
      createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
    ),
    targetRoot
  );

  return [...copyOperations, createPreToolUseBashGuardianHookMergeOperation(targetRoot, 'run_shell_command')];
}

function createQwenCrusherOperations(adapter, targetRoot) {
  const copyOperations = createCrusherScriptCopyOperations(
    (moduleId, sourceRelativePath, destinationPath, options) => (
      createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
    ),
    targetRoot
  );

  return [...copyOperations, createPreToolUseCrusherHookMergeOperation(targetRoot, 'run_shell_command')];
}

// The session hooks, in the same settings.json and the same format
// ([Qwen Code hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/),
// read on 2026-11-27): SessionStart gets session_id and cwd and reads
// hookSpecificOutput.additionalContext back, so the project memory reaches
// the session and the Team Brain is pulled when the team asks for it; Stop
// pushes what changed.
const QWEN_SESSION_START_SOURCE_RELATIVE_PATH = 'scripts/hooks/qwen-session-start.js';

function createQwenSessionOperations(adapter, targetRoot, plannedDestinations) {
  return createHostSessionHookOperations({
    createRemappedOperation: (moduleId, sourceRelativePath, destinationPath, options) => (
      createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
    ),
    targetRoot,
    hooksFilePath: resolveSettingsPath(targetRoot),
    sessionStartSourceRelativePath: QWEN_SESSION_START_SOURCE_RELATIVE_PATH,
    plannedDestinations,
  });
}

module.exports = createInstallTargetAdapter({
  id: 'qwen-project',
  target: 'qwen',
  kind: 'project',
  rootSegments: ['.qwen'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.qwen',
  planOperations(input, adapter) {
    const planningInput = { repoRoot: input.repoRoot, projectRoot: input.projectRoot, homeDir: input.homeDir };
    const targetRoot = adapter.resolveRoot(planningInput);
    const planned = [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createQwenGuardianOperations(adapter, targetRoot),
      ...createQwenCrusherOperations(adapter, targetRoot),
    ];
    return [...planned, ...createQwenSessionOperations(adapter, targetRoot, new Set(planned.map(operation => operation.destinationPath)))];
  },
});
