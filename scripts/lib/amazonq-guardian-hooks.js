'use strict';

// Manages the Guardian entry inside an Amazon Q Developer CLI custom-agent
// config file (.amazonq/cli-agents/egc-guardian.json project-level, or
// ~/.aws/amazonq/cli-agents/egc-guardian.json global). Confirmed against
// aws/amazon-q-developer-cli's own docs (docs/agent-format.md,
// docs/custom-agents/management.md): one JSON file per agent, flat
// {hooks: {preToolUse: [{matcher, command}]}} shape -- structurally
// identical to Kiro's agent config, but reused here as a distinct module
// (not kiro-guardian-hooks.js) because the two hosts' preToolUse event
// string ('preToolUse') is byte-for-byte identical, and routing both
// through the same dispatch branch in claude-settings-hooks.js /
// install-lifecycle.js would make Amazon Q's operations silently execute
// Kiro-labeled code paths. OPERATION_DISPATCH_TAG below is an EGC-internal
// routing value only -- never written to disk -- kept distinct from Kiro's
// so the two hosts' apply/uninstall/inspect operations cannot collide.
//
// KNOWN CAVEAT (verified against aws/amazon-q-developer-cli#2922, an open
// upstream bug): naming this agent file `q_cli_default.json` -- the
// documented way to override Amazon Q's built-in default agent -- is
// currently a no-op; crates/chat-cli/src/cli/agent/mod.rs calls
// Agent::default() without checking for that override file first. Amazon Q
// settings (including chat.defaultAgent) live in an embedded database
// (crates/chat-cli/src/database/settings.rs), not a plain file, so EGC's
// filesystem-only installer cannot activate this agent as the session
// default either. The agent file installed here is real and enforces the
// Guardian correctly once active, but the user must run
// `q settings chat.defaultAgent egc-guardian` once, or pass
// `--agent egc-guardian` per session, until AWS ships a fix. Documented in
// integration-tiers.md, not silently glossed over.

const path = require('node:path');
const {
  addFlatHookEntry,
  applyFlatHookToFile,
  buildHookCommand,
  inspectFlatHookFile,
  removeFlatHookEntry,
  removeFlatHookFromFile,
} = require('./flat-hooks-json-merge');

const HOST_LABEL = 'Amazon Q';
const AGENT_CONFIG_EVENT_KEY = 'preToolUse';
const EXECUTE_BASH_MATCHER = 'execute_bash';
const OPERATION_DISPATCH_TAG = 'amazonq-preToolUse';
const GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH = 'scripts/hooks/amazonq-guardian-adapter.js';
const AGENT_FILE_NAME = 'egc-guardian.json';
const EGC_ADAPTER_BASENAME = path.basename(GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH);

function isOwnBasename(command) {
  return command.includes(EGC_ADAPTER_BASENAME);
}

function buildExtraEntryFields() {
  return { matcher: EXECUTE_BASH_MATCHER };
}

function resolveGuardianAdapterScriptDestination(targetRoot) {
  return path.join(targetRoot, 'scripts', 'hooks', 'amazonq-guardian-adapter.js');
}

function resolveAgentConfigPath(targetRoot) {
  return path.join(targetRoot, 'cli-agents', AGENT_FILE_NAME);
}

function addAmazonQHookEntry(config, command) {
  return addFlatHookEntry(config, AGENT_CONFIG_EVENT_KEY, command, {
    isOwnBasename,
    extraEntryFields: buildExtraEntryFields(),
  });
}

function applyAmazonQGuardianHookToFile(agentConfigPath, adapterScriptPath) {
  return applyFlatHookToFile(agentConfigPath, HOST_LABEL, AGENT_CONFIG_EVENT_KEY, buildHookCommand(adapterScriptPath), {
    isOwnBasename,
    extraEntryFields: buildExtraEntryFields(),
  });
}

function removeAmazonQHookEntry(config, command) {
  return removeFlatHookEntry(config, AGENT_CONFIG_EVENT_KEY, command);
}

function removeAmazonQGuardianHookFromFile(agentConfigPath, adapterScriptPath) {
  return removeFlatHookFromFile(agentConfigPath, HOST_LABEL, AGENT_CONFIG_EVENT_KEY, buildHookCommand(adapterScriptPath));
}

function inspectAmazonQGuardianHookFile(agentConfigPath, adapterScriptPath) {
  return inspectFlatHookFile(agentConfigPath, HOST_LABEL, AGENT_CONFIG_EVENT_KEY, buildHookCommand(adapterScriptPath));
}

module.exports = {
  AGENT_CONFIG_EVENT_KEY,
  EXECUTE_BASH_MATCHER,
  GUARDIAN_ADAPTER_SCRIPT_SOURCE_RELATIVE_PATH,
  OPERATION_DISPATCH_TAG,
  addAmazonQHookEntry,
  applyAmazonQGuardianHookToFile,
  inspectAmazonQGuardianHookFile,
  removeAmazonQGuardianHookFromFile,
  removeAmazonQHookEntry,
  resolveAgentConfigPath,
  resolveGuardianAdapterScriptDestination,
};
