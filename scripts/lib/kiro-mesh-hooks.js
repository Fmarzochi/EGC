'use strict';

// Session-mesh wake-signal notice for Kiro's hook panel
// (.kiro/hooks/<any>.json -- "Any .json filename works", kiro.dev/docs/hooks/):
// a dedicated egc-mesh-notice.json wholly owned by EGC, so apply and remove
// are whole-file operations with no user-content merge to get wrong. The
// UserPromptSubmit trigger with a command action feeds the command's stdout
// to the agent's context on exit 0 (kiro.dev/docs/hooks/actions/), which is
// exactly the mesh hook's --format=text contract: silence when quiet, one
// line when the bus moved. Prompt-submit hooks carry no tool_input, so the
// empty tool_input of IDE preToolUse hooks (kirodotdev/Kiro#7375) does not
// apply here.

const path = require('node:path');
const { buildHookCommand } = require('./flat-hooks-json-merge');
const { inspectOwnedHookFile, removeOwnedHookFile, writeOwnedHookFile } = require('./kiro-hook-files');

const OPERATION_DISPATCH_TAG = 'kiro-mesh-hook-file';
const MESH_HOOK_FILE_NAME = 'egc-mesh-notice.json';

function resolveMeshHookFilePath(targetRoot) {
  return path.join(targetRoot, 'hooks', MESH_HOOK_FILE_NAME);
}

function buildMeshHookCommand(meshScriptPath) {
  return `${buildHookCommand(meshScriptPath)} --format=text`;
}

function buildMeshHookDocument(meshScriptPath) {
  return {
    version: 'v1',
    hooks: [
      {
        name: 'EGC session-mesh wake signal',
        description: 'Injects a one-line notice when the shared EGC session bus moved, so this tab drains its events with session_events.',
        trigger: 'UserPromptSubmit',
        action: { type: 'command', command: buildMeshHookCommand(meshScriptPath) },
        timeout: 10,
        enabled: true,
      },
    ],
  };
}

function applyKiroMeshHookToFile(hookFilePath, meshScriptPath) {
  return writeOwnedHookFile(hookFilePath, buildMeshHookDocument(meshScriptPath));
}

function removeKiroMeshHookFromFile(hookFilePath) {
  return removeOwnedHookFile(hookFilePath);
}

function inspectKiroMeshHookFile(hookFilePath, meshScriptPath) {
  return inspectOwnedHookFile(hookFilePath, buildMeshHookDocument(meshScriptPath));
}

module.exports = {
  MESH_HOOK_FILE_NAME,
  OPERATION_DISPATCH_TAG,
  applyKiroMeshHookToFile,
  buildMeshHookCommand,
  inspectKiroMeshHookFile,
  removeKiroMeshHookFromFile,
  resolveMeshHookFilePath,
};
