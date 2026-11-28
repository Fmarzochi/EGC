'use strict';

const path = require('node:path');
const { buildHookCommand } = require('./flat-hooks-json-merge');
const { inspectOwnedHookFile, removeOwnedHookFile, writeOwnedHookFile } = require('./kiro-hook-files');

const OPERATION_DISPATCH_TAG = 'grok-guardian-hook-file';
const GROK_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH = 'scripts/hooks/grok-guardian-adapter.js';
const GUARDIAN_HOOK_FILE_NAME = 'egc-guardian.json';
const GUARDIAN_MATCHER = 'Bash|Edit|Write|run_terminal_command|monitor|search_replace|write';
// The session hooks, one owned file each in the same personal hooks folder
// ([Grok hooks](https://docs.x.ai/build/features/hooks), read on 2026-11-28):
// SessionStart and Stop are passive events (no matcher, stdout ignored), with
// sessionId, cwd and workspaceRoot on stdin and a timeout in seconds that
// defaults to 5, too short for a Team Brain pull or push over the network.
const GROK_SESSION_START_SOURCE_RELATIVE_PATH = 'scripts/hooks/grok-session-start.js';
const GROK_SESSION_HOOK_FILES = Object.freeze({
  SessionStart: Object.freeze({ tag: 'grok-session-start-hook-file', fileName: 'egc-session-start.json', timeout: 30 }),
  Stop: Object.freeze({ tag: 'grok-stop-hook-file', fileName: 'egc-stop.json', timeout: 60 }),
});

function resolveGrokGuardianHookFilePath(targetRoot) {
  return path.join(targetRoot, 'hooks', GUARDIAN_HOOK_FILE_NAME);
}

function resolveGrokSessionHookFilePath(targetRoot, event) {
  return path.join(targetRoot, 'hooks', GROK_SESSION_HOOK_FILES[event].fileName);
}

function buildGrokSessionHookDocument(event, hookScriptPath) {
  return {
    hooks: {
      [event]: [{ hooks: [{ type: 'command', command: buildHookCommand(hookScriptPath), timeout: GROK_SESSION_HOOK_FILES[event].timeout }] }],
    },
  };
}

function applyGrokSessionHookToFile(hookFilePath, hookScriptPath, event) {
  return writeOwnedHookFile(hookFilePath, buildGrokSessionHookDocument(event, hookScriptPath));
}

function inspectGrokSessionHookFile(hookFilePath, hookScriptPath, event) {
  return inspectOwnedHookFile(hookFilePath, buildGrokSessionHookDocument(event, hookScriptPath));
}

function resolveGrokGuardianAdapterDestination(targetRoot) {
  return path.join(targetRoot, ...GROK_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH.split('/'));
}

function buildGrokGuardianHookDocument(adapterScriptPath) {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: GUARDIAN_MATCHER,
          hooks: [{ type: 'command', command: buildHookCommand(adapterScriptPath), timeout: 30 }],
        },
      ],
    },
  };
}

function applyGrokGuardianHookToFile(hookFilePath, adapterScriptPath) {
  return writeOwnedHookFile(hookFilePath, buildGrokGuardianHookDocument(adapterScriptPath));
}

function removeGrokGuardianHookFromFile(hookFilePath) {
  return removeOwnedHookFile(hookFilePath);
}

function inspectGrokGuardianHookFile(hookFilePath, adapterScriptPath) {
  return inspectOwnedHookFile(hookFilePath, buildGrokGuardianHookDocument(adapterScriptPath));
}

module.exports = {
  GROK_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH,
  GROK_SESSION_HOOK_FILES,
  GROK_SESSION_START_SOURCE_RELATIVE_PATH,
  GUARDIAN_HOOK_FILE_NAME,
  GUARDIAN_MATCHER,
  OPERATION_DISPATCH_TAG,
  applyGrokGuardianHookToFile,
  applyGrokSessionHookToFile,
  buildGrokGuardianHookDocument,
  buildGrokSessionHookDocument,
  inspectGrokGuardianHookFile,
  inspectGrokSessionHookFile,
  removeGrokGuardianHookFromFile,
  removeGrokSessionHookFromFile: removeOwnedHookFile,
  resolveGrokGuardianAdapterDestination,
  resolveGrokGuardianHookFilePath,
  resolveGrokSessionHookFilePath,
};
