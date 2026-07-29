'use strict';

// Manages the Guardian entry inside a Kiro CLI agent config file
// (.kiro/agents/default.json project-level, or ~/.kiro/agents/default.json
// global). Kiro CLI agents are one JSON file per agent (the filename minus
// .json is the agent's name; `default` is the documented convention and
// what `chat.defaultAgent` points to unless a user overrides it) with a
// flat {hooks: {<event>: [{matcher, command}]}} map inside -- the same
// non-Claude-schema shape flat-hooks-json-merge.js already handles for
// Windsurf/Cursor, plus a `matcher` field on each entry (Kiro's preToolUse
// fires for every tool -- fs_read, fs_write, execute_bash -- not just shell
// commands the way Cursor's beforeShellExecution already is scoped, so the
// Guardian's own entry needs `matcher: "execute_bash"` to avoid running on
// file tools it was never meant to validate).
// Docs: https://kiro.dev/docs/cli/hooks/,
// https://kiro.dev/docs/cli/custom-agents/configuration-reference/
//
// Two upstream inconsistencies confirmed via kirodotdev/Kiro's own issue
// tracker before wiring this (not guessed): the IDE's preToolUse runCommand
// hooks currently pass an empty tool_input ({}), only the CLI passes the
// full {tool_name, tool_input, cwd, ...} context (kirodotdev/Kiro#7375) --
// so this integration targets the CLI's agent-config hooks specifically,
// not the IDE's separate .kiro/hooks/*.kiro.hook panel. CLI and IDE also
// read different shapes from the same ~/.kiro/agents/ directory
// (kirodotdev/Kiro#8040). The exact tool_input field holding the shell
// command string for execute_bash is undocumented publicly as of this
// writing; kiro-guardian-adapter.js reads tool_input.command by convention
// (every other host wired today -- Claude Code, Cursor, Windsurf, Codex --
// uses that exact field name) and fails open (allow) if it is absent,
// so a wrong guess degrades to a no-op instead of blocking everything.

const path = require('node:path');
const {
  addFlatHookEntry,
  applyFlatHookToFile,
  buildHookCommand,
  inspectFlatHookFile,
  removeFlatHookEntry,
  removeFlatHookFromFile,
} = require('./flat-hooks-json-merge');

const HOST_LABEL = 'Kiro';
const PRE_TOOL_USE_EVENT = 'preToolUse';
const EXECUTE_BASH_MATCHER = 'execute_bash';
const GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/kiro-guardian-adapter.js';
const DEFAULT_AGENT_FILE_NAME = 'default.json';
const EGC_ADAPTER_BASENAME = path.basename(GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);

function isOwnBasename(command) {
  return command.includes(EGC_ADAPTER_BASENAME);
}

function buildExtraEntryFields() {
  return { matcher: EXECUTE_BASH_MATCHER };
}

function resolveGuardianAdapterScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'kiro-guardian-adapter.js');
}

function resolveAgentConfigPath(targetRoot) {
  return path.join(targetRoot, 'agents', DEFAULT_AGENT_FILE_NAME);
}

function addKiroHookEntry(config, event, command) {
  return addFlatHookEntry(config, event, command, { isOwnBasename, extraEntryFields: buildExtraEntryFields() });
}

function applyKiroGuardianHookToFile(agentConfigPath, event, adapterScriptPath) {
  return applyFlatHookToFile(agentConfigPath, HOST_LABEL, event, buildHookCommand(adapterScriptPath), {
    isOwnBasename,
    extraEntryFields: buildExtraEntryFields(),
  });
}

function removeKiroHookEntry(config, event, command) {
  return removeFlatHookEntry(config, event, command);
}

function removeKiroGuardianHookFromFile(agentConfigPath, event, adapterScriptPath) {
  return removeFlatHookFromFile(agentConfigPath, HOST_LABEL, event, buildHookCommand(adapterScriptPath));
}

function inspectKiroGuardianHookFile(agentConfigPath, event, adapterScriptPath) {
  return inspectFlatHookFile(agentConfigPath, HOST_LABEL, event, buildHookCommand(adapterScriptPath));
}

module.exports = {
  EXECUTE_BASH_MATCHER,
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  PRE_TOOL_USE_EVENT,
  addKiroHookEntry,
  applyKiroGuardianHookToFile,
  inspectKiroGuardianHookFile,
  removeKiroGuardianHookFromFile,
  removeKiroHookEntry,
  resolveAgentConfigPath,
  resolveGuardianAdapterScriptDestination,
};
