'use strict';

// Wires the GateGuard fact-forcing gate into VS Code's Copilot agent hooks
// (Preview). VS Code documents its hooks.json as the exact same shape Claude
// Code uses -- {"hooks": {"PreToolUse": [{"matcher": ..., "hooks": [...]}]}}
// -- and explicitly lists it as one of the formats it reads for
// compatibility (see https://code.visualstudio.com/docs/agent-customization/hooks).
// That means the generic, destination-path-driven merge helpers already
// built for Claude's settings.json apply unchanged here; this module only
// supplies the VS Code-specific file location and reuses them.
//
// VS Code's documented user-level hook discovery path is `~/.copilot/hooks`,
// which is a different root than where copilot-home.js scaffolds skill
// content (~/.github). The GateGuard script itself is still deployed under
// the adapter's own root (~/.github/scripts/hooks/gateguard-fact-force.js)
// via the normal module path flow; this file's hooks.json merge just points
// its "command" at that already-installed script.

const path = require('node:path');

const {
  createGateGuardHookMergeOperationForDestination,
  resolveGateGuardHookScriptDestination,
  createCrusherHookMergeOperationForDestination,
  resolveCrusherHookScriptDestination,
  createBashGuardianHookMergeOperationForDestination,
  resolveBashGuardianHookScriptDestination,
} = require('./claude-settings-hooks');
const { HOOK_OPERATION_KIND, SESSION_START_EVENT, STOP_EVENT } = require('./claude-settings-hook-core');

// The session hooks: Copilot (the CLI and the VS Code agent) reads the
// Claude Code format when the event is named in PascalCase, so SessionStart
// and Stop go into the same hooks.json as the gates above. SessionStart
// restores the project memory as additionalContext and pulls the Team Brain
// when the team asks for it; Stop pushes what changed.
const SESSION_HOOK_MODULE_ID = 'egc-copilot-session-hook';
const SESSION_START_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/copilot-session-start.js';
const STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/team-sync-stop.js';

function resolveCopilotHooksFilePath(homeDir) {
  return path.join(homeDir, '.copilot', 'hooks', 'hooks.json');
}

function resolveSessionStartHookScriptDestination(targetRoot) {
  return path.join(targetRoot, ...SESSION_START_HOOK_SCRIPT_SOURCE_RELATIVE_PATH.split('/'));
}

function resolveStopHookScriptDestination(targetRoot) {
  return path.join(targetRoot, ...STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH.split('/'));
}

function createSessionHookMergeOperation(homeDir, hookEvent, sourceRelativePath, hookScriptPath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: SESSION_HOOK_MODULE_ID,
    sourceRelativePath,
    destinationPath: resolveCopilotHooksFilePath(homeDir),
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent,
    hookScriptPath,
  };
}

function createSessionStartHookMergeOperation(targetRoot, homeDir) {
  return createSessionHookMergeOperation(homeDir, SESSION_START_EVENT, SESSION_START_HOOK_SCRIPT_SOURCE_RELATIVE_PATH, resolveSessionStartHookScriptDestination(targetRoot));
}

function createStopHookMergeOperation(targetRoot, homeDir) {
  return createSessionHookMergeOperation(homeDir, STOP_EVENT, STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH, resolveStopHookScriptDestination(targetRoot));
}

function createPreToolUseGateGuardHookMergeOperation(targetRoot, homeDir, matcher) {
  return createGateGuardHookMergeOperationForDestination(
    resolveCopilotHooksFilePath(homeDir),
    resolveGateGuardHookScriptDestination(targetRoot),
    matcher
  );
}

// Token Crusher: VS Code's Copilot hooks read the same hooks.json schema, so the
// crusher hook (installed under the adapter's own ~/.github root) is registered
// at ~/.copilot/hooks/hooks.json just like the gate.
function createPreToolUseCrusherHookMergeOperation(targetRoot, homeDir, matcher) {
  return createCrusherHookMergeOperationForDestination(
    resolveCopilotHooksFilePath(homeDir),
    resolveCrusherHookScriptDestination(targetRoot),
    matcher
  );
}

// EGC Guardian: same hooks.json schema; GateGuard above only forces
// investigation before a risky action, it never checks a Bash command
// against the Guardian's actual allowlist/denylist. 2026-07-27 audit
// (EGC-462) found this target had GateGuard + Crusher wired but never the
// Guardian validator itself.
function createPreToolUseBashGuardianHookMergeOperation(targetRoot, homeDir, matcher) {
  return createBashGuardianHookMergeOperationForDestination(
    resolveCopilotHooksFilePath(homeDir),
    resolveBashGuardianHookScriptDestination(targetRoot),
    matcher
  );
}

module.exports = {
  SESSION_HOOK_MODULE_ID,
  SESSION_START_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  STOP_HOOK_SCRIPT_SOURCE_RELATIVE_PATH,
  createPreToolUseGateGuardHookMergeOperation,
  createPreToolUseCrusherHookMergeOperation,
  createPreToolUseBashGuardianHookMergeOperation,
  createSessionStartHookMergeOperation,
  createStopHookMergeOperation,
  resolveCopilotHooksFilePath,
  resolveSessionStartHookScriptDestination,
  resolveStopHookScriptDestination,
};
