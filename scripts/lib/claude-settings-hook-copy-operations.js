'use strict';

// Script-copy and destination-driven merge operations for the Crusher, Scrubber, mesh notice and Guardian hooks.
// Part of the claude-settings-hooks.js split; that file re-exports the public surface.

const path = require('node:path');
const {
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH: KIRO_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH,
} = require('./kiro-guardian-hooks');
const {
  OPERATION_DISPATCH_TAG: KIRO_MESH_HOOK_FILE_TAG,
  resolveMeshHookFilePath: resolveKiroMeshHookFilePath,
} = require('./kiro-mesh-hooks');
const {
  OPERATION_DISPATCH_TAG: KIRO_V3_GUARDIAN_HOOK_FILE_TAG,
  resolveGuardianHookFilePath: resolveKiroV3GuardianHookFilePath,
} = require('./kiro-v3-guardian-hooks');
const {
  GROK_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH,
  GROK_SESSION_HOOK_FILES,
  GROK_SESSION_START_SOURCE_RELATIVE_PATH,
  OPERATION_DISPATCH_TAG: GROK_GUARDIAN_HOOK_FILE_TAG,
  resolveGrokGuardianHookFilePath,
  resolveGrokSessionHookFilePath,
} = require('./grok-hooks');
const {
  SESSION_START_EVENT,
  STOP_EVENT,
  USER_PROMPT_SUBMIT_EVENT,
  PRE_TOOL_USE_EVENT,
  HOOK_OPERATION_KIND,
  WRITE_VALIDATOR_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  WRITE_VALIDATOR_HOOK_MODULE_ID,
  SCRUBBER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  SCRUBBER_HOOK_MODULE_ID,
  GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  GATEGUARD_HOOK_MODULE_ID,
  BASH_GUARDIAN_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  BASH_GUARDIAN_HOOK_MODULE_ID,
  CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  CRUSHER_HOOK_MODULE_ID,
  MESH_NOTICE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  MESH_NOTICE_HOOK_MODULE_ID,
} = require('./claude-settings-hook-core');
const {
  buildPreToolUseMergeOperation,
  resolveWriteValidatorHookScriptDestination,
  resolveScrubberHookScriptDestination,
} = require('./claude-settings-hook-events');

// Token Crusher hook (crusher-hook.js): standalone PreToolUse rewrite for hosts
// other than Claude Code that read hooks.json with the same schema (Codex,
// CodeBuddy). Its dependency tree is crusher-hook.js -> pre-bash-crusher-rewrite
// -> lib/crusher/engine, plus the shared pretooluse-output envelope. All are
// scaffolded together, preserving their relative paths so the requires resolve.
const CRUSHER_HOOK_LIB_SOURCES = [
  'scripts/hooks/pre-bash-crusher-rewrite.js',
  'scripts/hooks/pretooluse-output.js',
  'scripts/lib/crusher/engine.js',
  'scripts/lib/hook-stdin.js',
];

// scrubber-hook.js's transitive scrubber-lib dependencies, copied next to it so
// the write hook works even in an install that omits the hooks-runtime module.
const SCRUBBER_HOOK_LIB_SOURCES = [
  'scripts/lib/scrubber/engine.js',
  'scripts/lib/scrubber/binary-guard.js',
  'scripts/lib/scrubber/unicode-marks.js',
  'scripts/lib/scrubber/dash-normalize.js',
  'scripts/lib/hook-stdin.js',
];

function resolveCrusherHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'crusher-hook.js');
}

function createPreToolUseCrusherHookMergeOperation(targetRoot, matcher) {
  const hookScriptPath = resolveCrusherHookScriptDestination(targetRoot);
  return buildPreToolUseMergeOperation(
    targetRoot,
    CRUSHER_HOOK_MODULE_ID,
    CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    hookScriptPath,
    matcher
  );
}

function createCrusherScriptCopyOperations(createRemappedOperation, targetRoot) {
  return [
    createRemappedOperation(
      CRUSHER_HOOK_MODULE_ID,
      CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveCrusherHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    ...CRUSHER_HOOK_LIB_SOURCES.map(src => createRemappedOperation(
      CRUSHER_HOOK_MODULE_ID,
      src,
      path.join(targetRoot, ...src.split('/')),
      { strategy: 'preserve-relative-path' }
    )),
  ];
}

// Copy scrubber-hook.js and its scrubber-lib dependencies unconditionally, so
// registering the Scrubber settings entry never points at a missing script.
function createScrubberScriptCopyOperations(createRemappedOperation, targetRoot) {
  return [
    createRemappedOperation(
      SCRUBBER_HOOK_MODULE_ID,
      SCRUBBER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveScrubberHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    ...SCRUBBER_HOOK_LIB_SOURCES.map(src => createRemappedOperation(
      SCRUBBER_HOOK_MODULE_ID,
      src,
      path.join(targetRoot, ...src.split('/')),
      { strategy: 'preserve-relative-path' }
    )),
  ];
}

// Same merge operation shape as above, but for targets whose hooks.json
// location cannot be derived from resolveSettingsPath(targetRoot) the way
// Claude Code's can (e.g. Copilot's ~/.copilot/hooks/hooks.json, or
// Antigravity's project/global split): callers resolve destinationPath
// themselves and pass it in directly.
function createGateGuardHookMergeOperationForDestination(destinationPath, hookScriptPath, matcher) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: GATEGUARD_HOOK_MODULE_ID,
    sourceRelativePath: GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_TOOL_USE_EVENT,
    hookMatcher: matcher,
    hookScriptPath,
  };
}

// Crusher variant of the destination-driven merge op, for hosts whose
// hooks.json path is not derivable from targetRoot (Copilot ~/.copilot/hooks,
// Antigravity's project/global split). Same Claude hooks.json schema.
function createCrusherHookMergeOperationForDestination(destinationPath, hookScriptPath, matcher) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: CRUSHER_HOOK_MODULE_ID,
    sourceRelativePath: CRUSHER_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_TOOL_USE_EVENT,
    hookMatcher: matcher,
    hookScriptPath,
  };
}

// Session-mesh wake-signal notice (mesh-events-inject.js): standalone
// UserPromptSubmit hook, dependency-free by design (node builtins only), so
// a single script copy suffices. It emits the dual-field JSON shape
// (additionalContext + hookSpecificOutput) that Claude-schema and
// Gemini-schema hosts both read, which is exactly what Antigravity's
// hooks.json (project and global) consumes.
function resolveMeshNoticeHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'mesh-events-inject.js');
}

// The Team Brain sync at the turn boundary (team-autosync-turn.js) runs
// beside the shared script in every host root that loads it, so its helpers
// travel with the script; a host that syncs around the session instead
// (OpenCode's plugin) asks for the script alone.
const MESH_NOTICE_TEAM_SYNC_SOURCES = [
  'scripts/lib/team-autosync-turn.js',
  'scripts/lib/team-autosync-run.js',
  'scripts/lib/team-autosync.js',
  'scripts/lib/team-config.js',
  'scripts/lib/team-mcp-client.js',
  'scripts/lib/resolve-egc-root.js',
  'scripts/lib/utils.js',
  'scripts/lib/utils-platform.js',
  'scripts/lib/utils-paths.js',
  'scripts/lib/utils-session.js',
  'scripts/lib/utils-file.js',
  'scripts/lib/hook-stdin.js',
];

function createMeshNoticeScriptCopyOperations(createRemappedOperation, targetRoot, { withTeamSync = true } = {}) {
  const sources = withTeamSync ? MESH_NOTICE_TEAM_SYNC_SOURCES : [];
  return [
    createRemappedOperation(
      MESH_NOTICE_HOOK_MODULE_ID,
      MESH_NOTICE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveMeshNoticeHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    ...sources.map(source => createRemappedOperation(
      MESH_NOTICE_HOOK_MODULE_ID,
      source,
      path.join(targetRoot, ...source.split('/')),
      { strategy: 'preserve-relative-path' }
    )),
  ];
}

function createMeshNoticeHookMergeOperationForDestination(destinationPath, hookScriptPath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: MESH_NOTICE_HOOK_MODULE_ID,
    sourceRelativePath: MESH_NOTICE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: USER_PROMPT_SUBMIT_EVENT,
    hookScriptPath,
  };
}

// Kiro's hook panel takes a dedicated whole-file document instead of an
// entry merge; the operation dispatches on the Kiro-specific tag above.
function createKiroMeshHookFileOperation(targetRoot, hookScriptPath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: MESH_NOTICE_HOOK_MODULE_ID,
    sourceRelativePath: MESH_NOTICE_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath: resolveKiroMeshHookFilePath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: KIRO_MESH_HOOK_FILE_TAG,
    hookScriptPath,
  };
}

function createGrokGuardianHookFileOperation(targetRoot, hookScriptPath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: BASH_GUARDIAN_HOOK_MODULE_ID,
    sourceRelativePath: GROK_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH,
    destinationPath: resolveGrokGuardianHookFilePath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: GROK_GUARDIAN_HOOK_FILE_TAG,
    hookScriptPath,
  };
}

// The two session hooks of Grok Build, one owned file each under
// <root>/hooks: SessionStart runs the Grok wrapper of the shared host session
// start, Stop runs the shared team-sync-stop.js, both copied by
// createHostSessionHookCopyOperations with their paths kept.
function createGrokSessionHookFileOperations(targetRoot) {
  const scripts = {
    SessionStart: path.join(targetRoot, ...GROK_SESSION_START_SOURCE_RELATIVE_PATH.split('/')),
    Stop: resolveTeamSyncStopHookScriptDestination(targetRoot),
  };
  const sources = { SessionStart: GROK_SESSION_START_SOURCE_RELATIVE_PATH, Stop: TEAM_SYNC_STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH };
  return Object.entries(GROK_SESSION_HOOK_FILES).map(([event, file]) => ({
    kind: HOOK_OPERATION_KIND,
    moduleId: HOST_SESSION_HOOK_MODULE_ID,
    sourceRelativePath: sources[event],
    destinationPath: resolveGrokSessionHookFilePath(targetRoot, event),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: file.tag,
    hookScriptPath: scripts[event],
  }));
}

function createKiroV3GuardianHookFileOperation(targetRoot, hookScriptPath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: BASH_GUARDIAN_HOOK_MODULE_ID,
    sourceRelativePath: KIRO_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH,
    destinationPath: resolveKiroV3GuardianHookFilePath(targetRoot),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: KIRO_V3_GUARDIAN_HOOK_FILE_TAG,
    hookScriptPath,
  };
}

// EGC Guardian command validator (pre-bash-guardian-validate.js): standalone
// PreToolUse hook, same shape as the Crusher hook above, for hosts other than
// Claude Code that read hooks.json with the same schema. 2026-07-27 audit
// (EGC-460..464) found this was the one piece consistently missing from every
// non-Claude target that already had GateGuard + Crusher wired: those two
// give investigation-gating and output-compression, but neither one
// validates a command against the Guardian's actual allowlist/denylist —
// only pre-bash-guardian-validate.js does, and it was never registered
// anywhere except Claude Code's own bash-hook-dispatcher.js chain.
const BASH_GUARDIAN_HOOK_LIB_SOURCES = [
  'scripts/lib/guardian-bin.js',
  'scripts/lib/hook-stdin.js',
  // The hook flags: a host that runs the Guardian in-process (the OpenCode
  // plugin) reads EGC_DISABLED_HOOKS and EGC_HOOK_PROFILE through it.
  'scripts/lib/hook-flags.js',
  'scripts/lib/shell-split.js',
  'scripts/lib/wrapper-options.js',
  'scripts/lib/shell-bindings.js',
  'scripts/lib/shell-cwd.js',
  'scripts/lib/handoff-commands.js',
  'scripts/lib/stdin-programs.js',
  'scripts/hooks/pre-bash-guardian-shell-words.js',
  'scripts/hooks/pre-bash-guardian-wrapper-walk.js',
  'scripts/hooks/pre-bash-guardian-script-files.js',
  'scripts/hooks/pre-bash-guardian-segmentation.js',
  'scripts/hooks/pre-bash-guardian-script-walk.js',
];

function resolveBashGuardianHookScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'pre-bash-guardian-validate.js');
}

function createPreToolUseBashGuardianHookMergeOperation(targetRoot, matcher) {
  const hookScriptPath = resolveBashGuardianHookScriptDestination(targetRoot);
  return buildPreToolUseMergeOperation(
    targetRoot,
    BASH_GUARDIAN_HOOK_MODULE_ID,
    BASH_GUARDIAN_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    hookScriptPath,
    matcher
  );
}

// Destination-driven variant, for hosts whose hooks.json path is not
// derivable from targetRoot (Copilot ~/.copilot/hooks, Antigravity's
// project/global split). Same Claude hooks.json schema.
// Write validator (pre-write-guardian-validate.js) for hosts that read the
// Claude-style hooks.json but are not Claude Code: the same shape as the
// Bash guardian builders below, keyed on the write validator's module id.
function createWriteValidatorHookMergeOperationForDestination(destinationPath, hookScriptPath, matcher) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: WRITE_VALIDATOR_HOOK_MODULE_ID,
    sourceRelativePath: WRITE_VALIDATOR_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_TOOL_USE_EVENT,
    hookMatcher: matcher,
    hookScriptPath,
  };
}

// The write validator needs only guardian-bin.js, which the Bash guardian
// copy operations already ship, so one copy is enough.
function createWriteValidatorScriptCopyOperation(createRemappedOperation, targetRoot) {
  return createRemappedOperation(
    WRITE_VALIDATOR_HOOK_MODULE_ID,
    WRITE_VALIDATOR_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    resolveWriteValidatorHookScriptDestination(targetRoot),
    { strategy: 'preserve-relative-path' }
  );
}

function createBashGuardianHookMergeOperationForDestination(destinationPath, hookScriptPath, matcher) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: BASH_GUARDIAN_HOOK_MODULE_ID,
    sourceRelativePath: BASH_GUARDIAN_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: PRE_TOOL_USE_EVENT,
    hookMatcher: matcher,
    hookScriptPath,
  };
}

function createBashGuardianScriptCopyOperations(createRemappedOperation, targetRoot) {
  return [
    createRemappedOperation(
      BASH_GUARDIAN_HOOK_MODULE_ID,
      BASH_GUARDIAN_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
      resolveBashGuardianHookScriptDestination(targetRoot),
      { strategy: 'preserve-relative-path' }
    ),
    ...BASH_GUARDIAN_HOOK_LIB_SOURCES.map(src => createRemappedOperation(
      BASH_GUARDIAN_HOOK_MODULE_ID,
      src,
      path.join(targetRoot, ...src.split('/')),
      { strategy: 'preserve-relative-path' }
    )),
  ];
}

// Devin Desktop's, Cursor's, and Kiro's translation adapters
// (windsurf-guardian-adapter.js, cursor-guardian-adapter.js,
// kiro-guardian-adapter.js) all require ../lib/adapter-stdin-json.js for
// their truncation-aware stdin reader -- unlike pre-bash-guardian-
// validate.js itself, which every other target (Claude Code, Codex,
// Copilot, CodeBuddy, Antigravity) calls directly with no translation
// layer and so never needs this file. Kept separate from
// createBashGuardianScriptCopyOperations (shared by every target,
// including ones with no adapter) instead of folding it into
// BASH_GUARDIAN_HOOK_LIB_SOURCES, so targets without an adapter don't get
// a copy of a file they never require(). Confirmed missing on the real
// machine for all three hosts after merge (2026-07-29): the adapter
// crashed with MODULE_NOT_FOUND on every invocation because this file was
// never part of any target's copy operations.
const ADAPTER_STDIN_JSON_SOURCE_RELATIVE_PATH = 'scripts/lib/adapter-stdin-json.js';

function createAdapterStdinJsonCopyOperation(createRemappedOperation, targetRoot) {
  return createRemappedOperation(
    BASH_GUARDIAN_HOOK_MODULE_ID,
    ADAPTER_STDIN_JSON_SOURCE_RELATIVE_PATH,
    path.join(targetRoot, ...ADAPTER_STDIN_JSON_SOURCE_RELATIVE_PATH.split('/')),
    { strategy: 'preserve-relative-path' }
  );
}

// The session hooks of the hosts that read the Claude Code hook format
// (Copilot, Qwen Code, CodeBuddy, Junie, Auggie, Goose, Droid): SessionStart
// restores the project memory and pulls the Team Brain when the team asks
// for it, through the wrapper of the host; Stop pushes what changed, through
// the shared team-sync-stop.js. What the two load travels with its paths
// kept, so the requires resolve from <root>/scripts/hooks: the shared
// session adapter and what restores, decrypts and propagates the state (the
// list claude-home.js flattens into egc/lib), and the Team Brain sync.
const HOST_SESSION_HOOK_MODULE_ID = 'egc-host-session-hook';
const TEAM_SYNC_STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/team-sync-stop.js';
const SESSION_HOOK_LIB_SOURCES = [
  // What state-crypto.js, global-state.js, learning-store.js and
  // resolve-egc-root.js load at the top: without them the restore and the
  // sync fail silently where no gate planted them (Goose's own plugin).
  'scripts/lib/hook-stdin.js',
  'scripts/lib/utils.js',
  'scripts/lib/utils-file.js',
  'scripts/lib/utils-paths.js',
  'scripts/lib/utils-platform.js',
  'scripts/lib/utils-session.js',
  'scripts/lib/host-session-start.js',
  'scripts/lib/session-start-adapter.js',
  'scripts/lib/dashboard-token.js',
  'scripts/lib/crusher/session-marker.js',
  'scripts/lib/session-context-loader.js',
  'scripts/lib/branch-state.js',
  'scripts/lib/global-state.js',
  'scripts/lib/project-detect.js',
  'scripts/lib/propagate-state.js',
  'scripts/lib/state-crypto.js',
  // The state consolidation the session loader runs when it finds them: a
  // state file past the threshold is backed up and compacted on the host
  // the way it is where the hooks run from the repository.
  'scripts/lib/auto-consolidate.js',
  'scripts/lib/state-consolidate.js',
  'scripts/lib/learning-store.js',
  'scripts/lib/team-config.js',
  'scripts/lib/team-autosync.js',
  'scripts/lib/team-mcp-client.js',
  'scripts/lib/resolve-egc-root.js',
  // propagate-state.js's commit-privacy guard shells out to this script; with
  // the scripts/ prefix kept it lands where the runtime looks for it.
  'scripts/check-state-leak.js',
];

function resolveTeamSyncStopHookScriptDestination(targetRoot) {
  return path.join(targetRoot, ...TEAM_SYNC_STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH.split('/'));
}

// A destination the target already plans, as the file itself or as a
// directory above it: a selected module that copies scripts/lib whole
// covers every file under it.
function isPlannedDestination(plannedDestinations, destinationPath) {
  for (const planned of plannedDestinations) {
    if (destinationPath === planned || destinationPath.startsWith(planned + path.sep)) return true;
  }
  return false;
}

// The copies of the session hooks and what they load, under targetRoot; a
// destination the target already plans (the gates share several of these
// files, and a module may copy a whole folder) is left to that plan, so no
// file is planned twice.
function createHostSessionHookCopyOperations(createRemappedOperation, targetRoot, sessionStartSourceRelativePath, plannedDestinations = new Set()) {
  return [sessionStartSourceRelativePath, TEAM_SYNC_STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH, ...SESSION_HOOK_LIB_SOURCES]
    .map(sourceRelativePath => createRemappedOperation(
      HOST_SESSION_HOOK_MODULE_ID,
      sourceRelativePath,
      path.join(targetRoot, ...sourceRelativePath.split('/')),
      { strategy: 'preserve-relative-path' }
    ))
    .filter(operation => !isPlannedDestination(plannedDestinations, operation.destinationPath));
}

function createSessionStartHookMergeOperationForDestination(destinationPath, hookScriptPath, sourceRelativePath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: HOST_SESSION_HOOK_MODULE_ID,
    sourceRelativePath,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: SESSION_START_EVENT,
    hookScriptPath,
  };
}

function createStopHookMergeOperationForDestination(destinationPath, hookScriptPath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: HOST_SESSION_HOOK_MODULE_ID,
    sourceRelativePath: TEAM_SYNC_STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
    destinationPath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: STOP_EVENT,
    hookScriptPath,
  };
}

// Everything a host needs for its session hooks: the copies under targetRoot
// and the two entries in its hooks file (settings.json, config.json or a
// plugin's hooks.json, whatever the host reads), in the Claude Code format.
function createHostSessionHookOperations({ createRemappedOperation, targetRoot, hooksFilePath, sessionStartSourceRelativePath, plannedDestinations }) {
  const sessionStartScript = path.join(targetRoot, ...sessionStartSourceRelativePath.split('/'));
  return [
    ...createHostSessionHookCopyOperations(createRemappedOperation, targetRoot, sessionStartSourceRelativePath, plannedDestinations),
    createSessionStartHookMergeOperationForDestination(hooksFilePath, sessionStartScript, sessionStartSourceRelativePath),
    createStopHookMergeOperationForDestination(hooksFilePath, resolveTeamSyncStopHookScriptDestination(targetRoot)),
  ];
}

module.exports = {
  HOST_SESSION_HOOK_MODULE_ID,
  SESSION_HOOK_LIB_SOURCES,
  TEAM_SYNC_STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  createHostSessionHookCopyOperations,
  createHostSessionHookOperations,
  createSessionStartHookMergeOperationForDestination,
  createStopHookMergeOperationForDestination,
  resolveTeamSyncStopHookScriptDestination,
  CRUSHER_HOOK_LIB_SOURCES,
  BASH_GUARDIAN_HOOK_LIB_SOURCES,
  createGateGuardHookMergeOperationForDestination,
  createCrusherScriptCopyOperations,
  createPreToolUseCrusherHookMergeOperation,
  createCrusherHookMergeOperationForDestination,
  resolveCrusherHookScriptDestination,
  MESH_NOTICE_TEAM_SYNC_SOURCES,
  createMeshNoticeScriptCopyOperations,
  createMeshNoticeHookMergeOperationForDestination,
  createKiroMeshHookFileOperation,
  createGrokGuardianHookFileOperation,
  createGrokSessionHookFileOperations,
  createKiroV3GuardianHookFileOperation,
  resolveMeshNoticeHookScriptDestination,
  createBashGuardianScriptCopyOperations,
  createWriteValidatorHookMergeOperationForDestination,
  createWriteValidatorScriptCopyOperation,
  createPreToolUseBashGuardianHookMergeOperation,
  createBashGuardianHookMergeOperationForDestination,
  resolveBashGuardianHookScriptDestination,
  ADAPTER_STDIN_JSON_SOURCE_RELATIVE_PATH,
  createAdapterStdinJsonCopyOperation,
  createScrubberScriptCopyOperations,
};
