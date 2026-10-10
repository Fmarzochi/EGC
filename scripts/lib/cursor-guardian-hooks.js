'use strict';

// Manages the Guardian entry inside a Cursor Agent Hooks project-level
// .cursor/hooks.json file. Cursor's schema is a flat
// {version, hooks: {<event>: [{command, timeout?, matcher?}]}} map -- the
// same shape flat-hooks-json-merge.js handles for Devin Desktop's hooks.json
// too, plus a top-level `version` field Devin Desktop's file does not have.
// Docs: https://cursor.com/docs/agent/hooks

const fs = require('node:fs');
const path = require('node:path');
const {
  addFlatHookEntry,
  buildHookCommand,
  inspectFlatHookFile,
  readFlatHooksFile,
  removeFlatHookEntry,
  removeFlatHookFromFile,
  writeFlatHooksFile,
} = require('./flat-hooks-json-merge');

const HOST_LABEL = 'Cursor';
const BEFORE_SHELL_EXECUTION_EVENT = 'beforeShellExecution';
const GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/cursor-guardian-adapter.js';
const HOOKS_CONFIG_VERSION = 1;
const EGC_ADAPTER_BASENAME = path.basename(GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);
const RETIRED_EGC_ENTRIES = Object.freeze([
  Object.freeze({ event: 'beforeFileEdit', command: 'EGC_HOOK_EVENT=pre_tool node .cursor/hooks/dashboard-emit.js' }),
]);

function isOwnBasename(command) {
  return command.includes(EGC_ADAPTER_BASENAME);
}

function buildExtraTopLevel(base) {
  return { version: base.version || HOOKS_CONFIG_VERSION };
}

function resolveGuardianAdapterScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'cursor-guardian-adapter.js');
}

function resolveHooksJsonPath(targetRoot) {
  return path.join(targetRoot, 'hooks.json');
}

function addCursorHookEntry(config, event, command) {
  return addFlatHookEntry(config, event, command, { isOwnBasename, buildExtraTopLevel });
}

function applyCursorGuardianHookToFile(hooksJsonPath, event, adapterScriptPath, options = {}) {
  const seedPath = options?.seedPath;
  if (seedPath && !fs.existsSync(hooksJsonPath) && fs.existsSync(seedPath)) {
    try {
      const seedConfig = retireEgcEntries(JSON.parse(fs.readFileSync(seedPath, 'utf8'))).config;
      const command = buildHookCommand(adapterScriptPath);
      const { config } = addFlatHookEntry(seedConfig, event, command, {
        isOwnBasename,
        buildExtraTopLevel,
      });
      writeFlatHooksFile(hooksJsonPath, config);
      return { changed: true };
    } catch {
      // Fall back to default empty-file merge if seed read fails
    }
  }

  const current = readFlatHooksFile(hooksJsonPath, HOST_LABEL);
  const retired = retireEgcEntries(current);
  const { config, changed } = addFlatHookEntry(retired.config, event, buildHookCommand(adapterScriptPath), {
    isOwnBasename,
    buildExtraTopLevel,
  });
  if (changed || retired.changed) {
    writeFlatHooksFile(hooksJsonPath, config);
  }
  return { changed: changed || retired.changed };
}

function retireEgcEntries(config) {
  return RETIRED_EGC_ENTRIES.reduce((state, { event, command }) => {
    const next = removeFlatHookEntry(state.config, event, command);
    return { config: next.config, changed: state.changed || next.changed };
  }, { config, changed: false });
}

function removeCursorHookEntry(config, event, command) {
  return removeFlatHookEntry(config, event, command);
}

function removeCursorGuardianHookFromFile(hooksJsonPath, event, adapterScriptPath) {
  return removeFlatHookFromFile(hooksJsonPath, HOST_LABEL, event, buildHookCommand(adapterScriptPath));
}

function inspectCursorGuardianHookFile(hooksJsonPath, event, adapterScriptPath) {
  return inspectFlatHookFile(hooksJsonPath, HOST_LABEL, event, buildHookCommand(adapterScriptPath));
}

module.exports = {
  BEFORE_SHELL_EXECUTION_EVENT,
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  RETIRED_EGC_ENTRIES,
  addCursorHookEntry,
  applyCursorGuardianHookToFile,
  buildExtraTopLevel,
  inspectCursorGuardianHookFile,
  removeCursorGuardianHookFromFile,
  removeCursorHookEntry,
  resolveGuardianAdapterScriptDestination,
  resolveHooksJsonPath,
};
