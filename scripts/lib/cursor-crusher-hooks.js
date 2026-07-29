'use strict';

// Manages the Token Crusher entry inside a Cursor Agent Hooks project-level
// .cursor/hooks.json file. Unlike the Guardian validator (registered on
// beforeShellExecution, whose response can only allow/deny/ask -- confirmed
// against https://cursor.com/docs/agent/hooks), the Crusher needs to
// REWRITE the command before it runs, which only the generic preToolUse
// event supports, via `updated_input` in the response. Reuses the same flat
// {hooks: {<event>: [{command}]}} merge primitives cursor-guardian-hooks.js
// uses for beforeShellExecution, targeting preToolUse instead -- a
// SEPARATE entry in the same hooks.json, since Cursor's preToolUse fires
// for every tool (Shell, Read, Write, MCP, Task), not just shell commands.

const path = require('node:path');
const {
  applyFlatHookToFile,
  buildHookCommand,
  inspectFlatHookFile,
  removeFlatHookFromFile,
} = require('./flat-hooks-json-merge');
const { buildExtraTopLevel, resolveHooksJsonPath } = require('./cursor-guardian-hooks');

const HOST_LABEL = 'Cursor';
// The real Cursor event name written into hooks.json. Only used as the
// dispatch key inside THIS file's own functions -- claude-settings-hooks.js
// must NOT reuse this literal value as an operation.hookEvent dispatch key,
// because Kiro's own preToolUse event constant is the same string; see
// CRUSHER_HOOK_DISPATCH_EVENT below for the collision-free key.
const PRE_TOOL_USE_EVENT = 'preToolUse';
// Internal dispatch key for applyManagedHookOperation() in
// claude-settings-hooks.js -- deliberately NOT equal to 'preToolUse' (which
// Kiro's own operation.hookEvent already uses for a different merge
// function/schema). The real JSON event name Cursor expects is always
// PRE_TOOL_USE_EVENT above, hardcoded inside applyCursorCrusherHookToFile
// below, regardless of what dispatch key routed the call here.
const CRUSHER_HOOK_DISPATCH_EVENT = 'cursor:preToolUse';
const CRUSHER_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/cursor-crusher-adapter.js';
const EGC_ADAPTER_BASENAME = path.basename(CRUSHER_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);

function isOwnBasename(command) {
  return command.includes(EGC_ADAPTER_BASENAME);
}

function resolveCrusherAdapterScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'cursor-crusher-adapter.js');
}

function applyCursorCrusherHookToFile(hooksJsonPath, adapterScriptPath) {
  return applyFlatHookToFile(hooksJsonPath, HOST_LABEL, PRE_TOOL_USE_EVENT, buildHookCommand(adapterScriptPath), {
    isOwnBasename,
    buildExtraTopLevel,
  });
}

function removeCursorCrusherHookFromFile(hooksJsonPath, adapterScriptPath) {
  return removeFlatHookFromFile(hooksJsonPath, HOST_LABEL, PRE_TOOL_USE_EVENT, buildHookCommand(adapterScriptPath));
}

function inspectCursorCrusherHookFile(hooksJsonPath, adapterScriptPath) {
  return inspectFlatHookFile(hooksJsonPath, HOST_LABEL, PRE_TOOL_USE_EVENT, buildHookCommand(adapterScriptPath));
}

module.exports = {
  CRUSHER_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  CRUSHER_HOOK_DISPATCH_EVENT,
  PRE_TOOL_USE_EVENT,
  applyCursorCrusherHookToFile,
  inspectCursorCrusherHookFile,
  removeCursorCrusherHookFromFile,
  resolveCrusherAdapterScriptDestination,
  resolveHooksJsonPath,
};
