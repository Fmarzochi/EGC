'use strict';

const path = require('node:path');
const { buildHookCommand } = require('./flat-hooks-json-merge');
const { inspectOwnedHookFile, removeOwnedHookFile, writeOwnedHookFile } = require('./kiro-hook-files');

const OPERATION_DISPATCH_TAG = 'grok-guardian-hook-file';
const GROK_GUARDIAN_ADAPTER_SOURCE_RELATIVE_PATH = 'scripts/hooks/grok-guardian-adapter.js';
const GUARDIAN_HOOK_FILE_NAME = 'egc-guardian.json';
const GUARDIAN_MATCHER = 'Bash|Edit|Write';

function resolveGrokGuardianHookFilePath(targetRoot) {
  return path.join(targetRoot, 'hooks', GUARDIAN_HOOK_FILE_NAME);
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
  GUARDIAN_HOOK_FILE_NAME,
  GUARDIAN_MATCHER,
  OPERATION_DISPATCH_TAG,
  applyGrokGuardianHookToFile,
  buildGrokGuardianHookDocument,
  inspectGrokGuardianHookFile,
  removeGrokGuardianHookFromFile,
  resolveGrokGuardianAdapterDestination,
  resolveGrokGuardianHookFilePath,
};
