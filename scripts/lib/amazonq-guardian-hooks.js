'use strict';

// The Guardian entry EGC used to write into an Amazon Q Developer CLI
// custom-agent config file (.amazonq/cli-agents/egc-guardian.json in a
// project, ~/.aws/amazonq/cli-agents/egc-guardian.json at home): one JSON
// file per agent, flat {hooks: {preToolUse: [{matcher, command}]}} shape,
// per aws/amazon-q-developer-cli's own docs (docs/agent-format.md,
// docs/custom-agents/management.md).
//
// The Amazon Q adapters were retired on 2026-09-30 (AWS closed new
// sign-ups on 2026-05-15 and ends support on 2027-04-30; the CLI became the
// Kiro CLI, which the kiro adapters serve) and nothing plans this merge any
// more. What stays here is what installs of that adapter recorded as an
// OPERATION_DISPATCH_TAG hook operation: claude-settings-hooks.js and
// install-lifecycle.js dispatch it to these functions so `egc doctor` still
// reports the entry and `egc uninstall` still removes exactly what EGC
// added. The tag is an EGC-internal routing value, never written to disk,
// kept distinct from Kiro's although the two hosts share the same
// 'preToolUse' event string, so their operations cannot collide.

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
// The adapter script those installs pointed the entry at no longer ships;
// its basename is what tells an EGC entry from a third-party one.
const EGC_ADAPTER_BASENAME = 'amazonq-guardian-adapter.js';

function isOwnBasename(command) {
  return command.includes(EGC_ADAPTER_BASENAME);
}

function buildExtraEntryFields() {
  return { matcher: EXECUTE_BASH_MATCHER };
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
  OPERATION_DISPATCH_TAG,
  addAmazonQHookEntry,
  applyAmazonQGuardianHookToFile,
  inspectAmazonQGuardianHookFile,
  removeAmazonQGuardianHookFromFile,
  removeAmazonQHookEntry,
};
