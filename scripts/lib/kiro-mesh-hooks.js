'use strict';

// Session-mesh wake-signal notice for Kiro's hook panel
// (.kiro/hooks/<any>.json -- "Any .json filename works", kiro.dev/docs/hooks/):
// a dedicated egc-mesh-notice.json wholly owned by EGC, so apply and remove
// are whole-file operations with no user-content merge to get wrong. The
// UserPromptSubmit trigger with a command action feeds the command's stdout
// to the agent's context on exit 0 (kiro.dev/docs/hooks/actions/), which is
// exactly the mesh hook's --format=text contract: silence when quiet, one
// line when the bus moved. The known upstream inconsistency that keeps the
// Guardian on the CLI agent-config surface instead (empty tool_input on IDE
// preToolUse, kirodotdev/Kiro#7375) does not apply here: prompt-submit
// hooks carry no tool_input at all. Cross-checked against a second
// independent documentation pass before wiring, not assumed.

const fs = require('node:fs');
const path = require('node:path');
const { buildHookCommand } = require('./flat-hooks-json-merge');

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
  const desired = `${JSON.stringify(buildMeshHookDocument(meshScriptPath), null, 2)}\n`;
  try {
    if (fs.readFileSync(hookFilePath, 'utf8') === desired) {
      return { changed: false };
    }
  } catch { /* missing or unreadable: write below */ }
  fs.mkdirSync(path.dirname(hookFilePath), { recursive: true });
  fs.writeFileSync(hookFilePath, desired);
  return { changed: true };
}

function removeKiroMeshHookFromFile(hookFilePath) {
  try {
    fs.unlinkSync(hookFilePath);
    return { changed: true };
  } catch {
    return { changed: false };
  }
}

function inspectKiroMeshHookFile(hookFilePath, meshScriptPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(hookFilePath, 'utf8'));
    const hooks = Array.isArray(parsed?.hooks) ? parsed.hooks : [];
    const command = buildMeshHookCommand(meshScriptPath);
    return hooks.some(entry => entry?.action?.command === command && entry?.trigger === 'UserPromptSubmit')
      ? 'ok'
      : 'drifted';
  } catch {
    return 'drifted';
  }
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
