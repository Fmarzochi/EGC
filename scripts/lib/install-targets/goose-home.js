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
  createHostSessionHookOperations,
} = require('../claude-settings-hooks');

// Goose already reads skills from ~/.agents/skills/<name>/ -- the same
// shared directory codex-home.js writes to. This adapter exists purely for
// discoverability (`--target goose` instead of requiring `--target codex`).
//
// EGC-498 (corrected): Goose does have a real hook API -- confirmed
// against aaif-goose/goose's own docs/guides/context-engineering/hooks.md
// and the shipped PreToolUse-denial code (PR #9304, merged 2026-05-19).
// Plugin config lives at ~/.agents/plugins/<plugin-name>/hooks/hooks.json
// (same .agents root skills already use, a different subtree), in the
// exact {hooks: {PreToolUse: [{matcher, hooks: [{type, command}]}]}} shape
// as Claude Code's own settings.json (Goose's docs describe this hook
// format as following Claude Code's convention) -- so this reuses
// claude-settings-hooks.js's destination-driven merge builders instead of
// a bespoke merge module, same pattern as Junie/Trae's own config files.
// No rewrite capability is documented (allow/deny only), so Token Crusher
// stays out of scope here, same as Kiro/Devin Desktop/Cline.
function resolveGoosePluginHooksJsonPath(pluginRoot) {
  return path.join(pluginRoot, 'hooks', 'hooks.json');
}

function createGooseGuardianOperations(adapter, targetRoot) {
  const remap = (moduleId, sourceRelativePath, destinationPath, options) => (
    createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
  );

  // Everything the plugin needs (shared Guardian scripts, the adapter
  // itself, hooks.json) lives under this one self-contained plugin root --
  // NOT scattered across the shared .agents/scripts/ tree other adapters
  // (codex-home.js et al.) use for their own hooks. goose-guardian-
  // adapter.js does a plain `require('./pre-bash-guardian-validate')`, so
  // its sibling files must be installed relative to IT, not to targetRoot.
  const pluginRoot = path.join(targetRoot, 'plugins', 'egc-guardian');
  const adapterModuleId = 'egc-goose-guardian-hook';
  const adapterScriptDestination = path.join(pluginRoot, 'scripts', 'hooks', 'goose-guardian-adapter.js');

  return [
    ...createBashGuardianScriptCopyOperations(remap, pluginRoot),
    remap(adapterModuleId, 'scripts/hooks/goose-guardian-adapter.js', adapterScriptDestination, { strategy: 'preserve-relative-path' }),
    createAdapterStdinJsonCopyOperation(remap, pluginRoot),
    createBashGuardianHookMergeOperationForDestination(
      resolveGoosePluginHooksJsonPath(pluginRoot),
      adapterScriptDestination,
      'developer__shell'
    ),
  ];
}

// The session hooks, in a plugin of their own (~/.agents/plugins/egc-session,
// the layout Goose discovers, hooks/hooks.json in the Claude Code format;
// [Goose hooks](https://goose-docs.ai/blog/2026/05/14/goose-hooks), read on
// 2026-11-27): SessionStart gets session_id and working_dir and reads
// additionalContext back, so the project memory reaches the session and the
// Team Brain is pulled when the team asks for it; Stop pushes what changed.
// The plugin is self-contained like the Guardian's: the wrapper, the shared
// push script and what they load live under its root.
const GOOSE_SESSION_START_SOURCE_RELATIVE_PATH = 'scripts/hooks/goose-session-start.js';

function createGooseSessionOperations(adapter, targetRoot) {
  const pluginRoot = path.join(targetRoot, 'plugins', 'egc-session');
  return createHostSessionHookOperations({
    createRemappedOperation: (moduleId, sourceRelativePath, destinationPath, options) => (
      createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options)
    ),
    targetRoot: pluginRoot,
    hooksFilePath: resolveGoosePluginHooksJsonPath(pluginRoot),
    sessionStartSourceRelativePath: GOOSE_SESSION_START_SOURCE_RELATIVE_PATH,
    plannedDestinations: new Set(),
  });
}

module.exports = createInstallTargetAdapter({
  id: 'goose-home',
  target: 'goose',
  kind: 'home',
  rootSegments: ['.agents'],
  installStatePathSegments: ['egc', 'goose-install-state.json'],
  nativeRootRelativePath: '.agents',
  planOperations(input, adapter) {
    const planningInput = { repoRoot: input.repoRoot, projectRoot: input.projectRoot, homeDir: input.homeDir };
    const targetRoot = adapter.resolveRoot(planningInput);
    return [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createGooseGuardianOperations(adapter, targetRoot),
      ...createGooseSessionOperations(adapter, targetRoot),
    ];
  },
});
