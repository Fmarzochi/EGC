'use strict';

// Wires the GateGuard fact-forcing gate into Antigravity's own hooks.json.
// Antigravity (Google's agentic IDE, built on the Gemini CLI agent loop and
// sharing its GEMINI_PROJECT_DIR / GEMINI_PLUGIN_ROOT environment variables)
// documents two hooks.json locations distinct from Gemini CLI's own
// ~/.gemini/hooks/hooks.json:
//   - Project: <project_root>/.agents/hooks.json
//   - Global:  ~/.gemini/antigravity-cli/hooks.json
// (see "A Developer's Guide to Agent Hooks in Antigravity CLI", Google Cloud
// Community / Medium, June 2026 -- the primary antigravity.google/docs/hooks
// page is a client-rendered SPA this toolchain cannot execute, so this
// community guide plus Google's own search index snippet of that page are
// the best available evidence). Both locations use the same
// {"hooks": {"PreToolUse": [{"matcher", "hooks"}]}} shape already confirmed
// working in this repo's own hooks/hooks.json (which Gemini CLI reads
// successfully today), so the generic Claude merge helpers apply unchanged;
// this module only supplies Antigravity's two file locations.

const path = require('path');

const {
  GATEGUARD_HOOK_MODULE_ID,
  GATEGUARD_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  HOOK_OPERATION_KIND,
  PRE_TOOL_USE_EVENT,
  resolveGateGuardHookScriptDestination,
} = require('./claude-settings-hooks');

function resolveAntigravityProjectHooksFilePath(projectRoot) {
  return path.join(projectRoot, '.agents', 'hooks.json');
}

function resolveAntigravityGlobalHooksFilePath(homeDir) {
  return path.join(homeDir, '.gemini', 'antigravity-cli', 'hooks.json');
}

function buildGateGuardMergeOperation(destinationPath, hookScriptPath, matcher) {
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

function createProjectGateGuardHookMergeOperation(targetRoot, projectRoot, matcher) {
  return buildGateGuardMergeOperation(
    resolveAntigravityProjectHooksFilePath(projectRoot),
    resolveGateGuardHookScriptDestination(targetRoot),
    matcher
  );
}

function createGlobalGateGuardHookMergeOperation(targetRoot, homeDir, matcher) {
  return buildGateGuardMergeOperation(
    resolveAntigravityGlobalHooksFilePath(homeDir),
    resolveGateGuardHookScriptDestination(targetRoot),
    matcher
  );
}

module.exports = {
  createGlobalGateGuardHookMergeOperation,
  createProjectGateGuardHookMergeOperation,
  resolveAntigravityGlobalHooksFilePath,
  resolveAntigravityProjectHooksFilePath,
};
