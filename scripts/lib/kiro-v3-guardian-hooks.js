'use strict';

const path = require('node:path');
const { buildHookCommand } = require('./flat-hooks-json-merge');
const { inspectOwnedHookFile, removeOwnedHookFile, writeOwnedHookFile } = require('./kiro-hook-files');

const OPERATION_DISPATCH_TAG = 'kiro-v3-guardian-hook-file';
const GUARDIAN_HOOK_FILE_NAME = 'egc-guardian.json';
const PRE_TOOL_USE_TRIGGER = 'PreToolUse';
const SHELL_MATCHER = 'shell';

function resolveGuardianHookFilePath(targetRoot) {
  return path.join(targetRoot, 'hooks', GUARDIAN_HOOK_FILE_NAME);
}

function buildGuardianHookDocument(adapterScriptPath) {
  return {
    version: 'v1',
    hooks: [
      {
        name: 'EGC Guardian',
        description: 'Validates every shell command with the EGC Guardian before it runs; exit code 2 blocks the command.',
        trigger: PRE_TOOL_USE_TRIGGER,
        matcher: SHELL_MATCHER,
        action: { type: 'command', command: buildHookCommand(adapterScriptPath) },
        timeout: 30,
        enabled: true,
      },
    ],
  };
}

function applyKiroV3GuardianHookToFile(hookFilePath, adapterScriptPath) {
  return writeOwnedHookFile(hookFilePath, buildGuardianHookDocument(adapterScriptPath));
}

function removeKiroV3GuardianHookFromFile(hookFilePath) {
  return removeOwnedHookFile(hookFilePath);
}

function inspectKiroV3GuardianHookFile(hookFilePath, adapterScriptPath) {
  return inspectOwnedHookFile(hookFilePath, buildGuardianHookDocument(adapterScriptPath));
}

module.exports = {
  GUARDIAN_HOOK_FILE_NAME,
  OPERATION_DISPATCH_TAG,
  PRE_TOOL_USE_TRIGGER,
  SHELL_MATCHER,
  applyKiroV3GuardianHookToFile,
  buildGuardianHookDocument,
  inspectKiroV3GuardianHookFile,
  removeKiroV3GuardianHookFromFile,
  resolveGuardianHookFilePath,
};
