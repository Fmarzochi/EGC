const os = require('os');
const path = require('path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  planFlatSkillOperation,
} = require('./helpers');
const {
  GATEGUARD_HOOK_MODULE_ID,
  GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  HOOK_OPERATION_KIND,
  PRE_TOOL_USE_EVENT,
  createGateGuardScriptCopyOperations,
} = require('../claude-settings-hooks');

// Codex CLI's skills root (~/.agents, this adapter's own resolveRoot()) and
// its runtime config root (~/.codex, where hooks.json/config.toml live) are
// two different directories - confirmed against scripts/codex/*.sh and
// codex-hooks.test.js, which both key hook/config installation off
// CODEX_HOME (default ~/.codex), independent of AGENTS_HOME (default
// ~/.agents). A PreToolUse hook registered under ~/.agents would never be
// discovered by Codex CLI, so the gate has to be wired into ~/.codex/hooks.json
// directly. Docs: https://developers.openai.com/codex/hooks (redirects to
// https://learn.chatgpt.com/docs/hooks) documents ~/.codex/hooks.json as a
// discovery location and the exact same
// {hooks: {PreToolUse: [{matcher, hooks: [{type, command}]}]}} JSON schema,
// including hookSpecificOutput.permissionDecision:"deny" for blocking, that
// gateguard-fact-force.js's CLI entrypoint already emits for Claude Code.
//
// Deliberately does NOT read process.env.CODEX_HOME here (unlike the
// standalone scripts/sync-egc-to-codex.sh flow): every other adapter in this
// registry derives its root purely from `input.homeDir`, and honoring an
// ambient env var would make this adapter's output depend on the caller's
// shell environment instead of its explicit input, which breaks test
// hermeticity and risks writing to a real ~/.codex during a hermetic test run.
function resolveCodexHome(input) {
  return path.join(input.homeDir || os.homedir(), '.codex');
}

function buildCodexPreToolUseMergeOperation(codexHome, hookScriptPath, matcher) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: GATEGUARD_HOOK_MODULE_ID,
    sourceRelativePath: GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: path.join(codexHome, 'hooks.json'),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_TOOL_USE_EVENT,
    hookMatcher: matcher,
    hookScriptPath,
  };
}

function createCodexGateGuardOperations(adapter, codexHome) {
  const hookScriptPath = path.join(codexHome, 'scripts', 'hooks', 'gateguard-fact-force.js');
  const copyOperations = createGateGuardScriptCopyOperations(
    (moduleId, sourceRelativePath, destinationPath, options) => (
      createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
    ),
    codexHome
  );

  // "apply_patch" is Codex's canonical tool_name for file edits (Edit/Write
  // are matcher aliases only, per codex-rs/core/src/tools/hook_names.rs);
  // "Bash" is used verbatim for both the legacy shell tool and unified_exec.
  const mergeOperations = ['apply_patch', 'Bash'].map(matcher => (
    buildCodexPreToolUseMergeOperation(codexHome, hookScriptPath, matcher)
  ));

  return [...copyOperations, ...mergeOperations];
}

module.exports = createInstallTargetAdapter({
  id: 'codex-home',
  target: 'codex',
  kind: 'home',
  rootSegments: ['.agents'],
  installStatePathSegments: ['egc', 'codex-install-state.json'],
  nativeRootRelativePath: '.agents',
  planOperations(input, adapter) {
    const modules = Array.isArray(input.modules)
      ? input.modules
      : (input.module ? [input.module] : []);
    const planningInput = {
      repoRoot: input.repoRoot,
      projectRoot: input.projectRoot,
      homeDir: input.homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

    const moduleOperations = modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths.map(sourceRelativePath => planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot));
    });

    return [
      ...moduleOperations,
      ...createCodexGateGuardOperations(adapter, resolveCodexHome(planningInput)),
    ];
  },
});
