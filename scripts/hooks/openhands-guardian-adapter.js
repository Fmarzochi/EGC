#!/usr/bin/env node
/**
 * OpenHands hooks.json adapter for the EGC Guardian command validator.
 *
 * OpenHands' pre_tool_use hook (OpenHands/docs' own
 * openhands/usage/customization/hooks.mdx) delivers the event as JSON on
 * stdin -- {event_type, tool_name, tool_input: {command}, working_dir,
 * session_id} -- plus environment variables (OPENHANDS_EVENT_TYPE,
 * OPENHANDS_TOOL_NAME, OPENHANDS_PROJECT_DIR, OPENHANDS_SESSION_ID); this
 * adapter reads the stdin JSON, the same contract every other host's
 * adapter here already uses, rather than the env vars. Blocks via exit
 * code 2 (reason on stderr) or a {"decision":"deny","reason":"..."} JSON
 * line on stdout -- this adapter always uses the exit-code form since
 * pre-bash-guardian-validate.js's run() already returns exactly that
 * contract. No rewrite capability is documented, so Token Crusher stays
 * out of scope here, same as Kiro/Windsurf/Cline/Amazon Q/Goose.
 *
 * Registered only on the "terminal" matcher (OpenHands' own example in its
 * hooks.mdx) -- the Guardian validates shell commands, not file
 * operations.
 */

'use strict';

const { run } = require('./pre-bash-guardian-validate');
const { bootstrapPlainExitCodeAdapter, createBashToolGuardianInputMapper } = require('../lib/adapter-stdin-json');

const buildGuardianInput = createBashToolGuardianInputMapper({ shellToolName: 'terminal', cwdKey: 'working_dir' });

module.exports = bootstrapPlainExitCodeAdapter({
  isMain: require.main === module,
  buildGuardianInput,
  runGuardian: run,
});
