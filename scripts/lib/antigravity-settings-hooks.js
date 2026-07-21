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

const path = require('node:path');

const {
  createGateGuardHookMergeOperationForDestination,
  resolveGateGuardHookScriptDestination,
  createCrusherHookMergeOperationForDestination,
  resolveCrusherHookScriptDestination,
} = require('./claude-settings-hooks');

function resolveAntigravityProjectHooksFilePath(projectRoot) {
  return path.join(projectRoot, '.agents', 'hooks.json');
}

function resolveAntigravityGlobalHooksFilePath(homeDir) {
  return path.join(homeDir, '.gemini', 'antigravity-cli', 'hooks.json');
}

function createProjectGateGuardHookMergeOperation(targetRoot, projectRoot, matcher) {
  return createGateGuardHookMergeOperationForDestination(
    resolveAntigravityProjectHooksFilePath(projectRoot),
    resolveGateGuardHookScriptDestination(targetRoot),
    matcher
  );
}

function createGlobalGateGuardHookMergeOperation(targetRoot, homeDir, matcher) {
  return createGateGuardHookMergeOperationForDestination(
    resolveAntigravityGlobalHooksFilePath(homeDir),
    resolveGateGuardHookScriptDestination(targetRoot),
    matcher
  );
}

// Token Crusher: same hooks.json shape, registered at the project hooks file
// (.agents/hooks.json) pointing at the crusher hook under the adapter root.
function createProjectCrusherHookMergeOperation(targetRoot, projectRoot, matcher) {
  return createCrusherHookMergeOperationForDestination(
    resolveAntigravityProjectHooksFilePath(projectRoot),
    resolveCrusherHookScriptDestination(targetRoot),
    matcher
  );
}

module.exports = {
  createGlobalGateGuardHookMergeOperation,
  createProjectGateGuardHookMergeOperation,
  createProjectCrusherHookMergeOperation,
  resolveAntigravityGlobalHooksFilePath,
  resolveAntigravityProjectHooksFilePath,
};
