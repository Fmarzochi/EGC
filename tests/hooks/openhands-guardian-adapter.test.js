/**
 * Tests for scripts/hooks/openhands-guardian-adapter.js
 *
 * OpenHands' pre_tool_use hook wire contract -- {event_type, tool_name,
 * tool_input, working_dir, session_id} on stdin, exit code 2 to block --
 * confirmed against OpenHands/docs' own
 * openhands/usage/customization/hooks.mdx. Case bodies are shared with the
 * other two EGC-498-corrected hosts via guardian-adapter-test-harness.js.
 */

const path = require('path');
const { runGuardianAdapterTests } = require('./guardian-adapter-test-harness');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'openhands-guardian-adapter.js');
const { buildGuardianInput } = require(adapterScript);

const ok = runGuardianAdapterTests({
  suiteLabel: 'openhands-guardian-adapter',
  adapterScript,
  buildGuardianInput,
  shellToolName: 'terminal',
  nonShellToolName: 'str_replace_editor',
  cwdKey: 'working_dir',
  buildEvent: (toolName, toolInput, extra) => ({
    event_type: 'pre_tool_use',
    tool_name: toolName,
    tool_input: toolInput,
    ...extra,
  }),
});

process.exit(ok ? 0 : 1);
