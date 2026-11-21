'use strict';

// The `version` field of the hooks file Copilot reads. The Copilot CLI
// reference says hook configuration files use JSON with version 1 and that a
// bad version rejects the whole file, so a file EGC writes in the Claude Code
// shape (which has no such field) has to carry it or every entry in it, the
// gates included, is ignored. One operation per Copilot install owns the
// field: applied after the entries are merged, it adds the field when it is
// missing and leaves everything else as it is; the generic merge keeps the
// field on later writes, since it spreads the file it read.

const fs = require('node:fs');
const path = require('node:path');

const { HOOK_OPERATION_KIND, readSettingsFile } = require('./claude-settings-hook-core');

const COPILOT_HOOKS_VERSION = 1;
const COPILOT_HOOKS_VERSION_TAG = 'copilot:hooks-version';
const COPILOT_HOOKS_VERSION_MODULE_ID = 'egc-copilot-hooks-version';
const COPILOT_HOOKS_VERSION_SOURCE_RELATIVE_PATH = 'scripts/lib/copilot-hooks-version.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The file with the version first, the rest as it was, and a hooks map so a
// file created by this step alone is complete.
function withVersion(settings) {
  const rest = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'version'));
  return { version: COPILOT_HOOKS_VERSION, ...rest, hooks: isPlainObject(rest.hooks) ? rest.hooks : {} };
}

function applyCopilotHooksVersionToFile(hooksFilePath) {
  const current = readSettingsFile(hooksFilePath);
  if (current.version === COPILOT_HOOKS_VERSION && isPlainObject(current.hooks)) return { changed: false };
  fs.mkdirSync(path.dirname(hooksFilePath), { recursive: true });
  fs.writeFileSync(hooksFilePath, `${JSON.stringify(withVersion(current), null, 2)}\n`, 'utf8');
  return { changed: true };
}

// The field stays when EGC's entries leave: a file the person keeps other
// hooks in needs it, and an empty one is harmless.
function removeCopilotHooksVersionFromFile() {
  return { changed: false };
}

function inspectCopilotHooksVersionFile(hooksFilePath) {
  try {
    return readSettingsFile(hooksFilePath).version === COPILOT_HOOKS_VERSION ? 'ok' : 'drifted';
  } catch {
    return 'drifted';
  }
}

function createCopilotHooksVersionOperation(hooksFilePath) {
  return {
    kind: HOOK_OPERATION_KIND,
    moduleId: COPILOT_HOOKS_VERSION_MODULE_ID,
    sourceRelativePath: COPILOT_HOOKS_VERSION_SOURCE_RELATIVE_PATH,
    destinationPath: hooksFilePath,
    strategy: HOOK_OPERATION_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
    hookEvent: COPILOT_HOOKS_VERSION_TAG,
    hookScriptPath: hooksFilePath,
  };
}

const COPILOT_HOOKS_VERSION_HANDLERS = {
  apply: operation => applyCopilotHooksVersionToFile(operation.destinationPath),
  remove: () => removeCopilotHooksVersionFromFile(),
  inspect: operation => inspectCopilotHooksVersionFile(operation.destinationPath),
};

module.exports = {
  COPILOT_HOOKS_VERSION,
  COPILOT_HOOKS_VERSION_TAG,
  COPILOT_HOOKS_VERSION_MODULE_ID,
  COPILOT_HOOKS_VERSION_HANDLERS,
  applyCopilotHooksVersionToFile,
  createCopilotHooksVersionOperation,
  inspectCopilotHooksVersionFile,
  removeCopilotHooksVersionFromFile,
};
