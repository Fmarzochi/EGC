/**
 * Tests for scripts/hooks/goose-guardian-adapter.js
 *
 * Goose's PreToolUse hook wire contract -- {event, session_id,
 * matcher_context, tool_name, tool_input, working_dir} on stdin, exit code
 * 2 to block -- confirmed against aaif-goose/goose's own
 * docs/guides/context-engineering/hooks.md. Case bodies are shared with the
 * other two EGC-498-corrected hosts via guardian-adapter-test-harness.js.
 */

const path = require('path');
const { runGuardianAdapterTests } = require('./guardian-adapter-test-harness');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'goose-guardian-adapter.js');
const { buildGuardianInput } = require(adapterScript);

const ok = runGuardianAdapterTests({
  suiteLabel: 'goose-guardian-adapter',
  adapterScript,
  buildGuardianInput,
  shellToolName: 'developer__shell',
  nonShellToolName: 'developer__text_editor',
  cwdKey: 'working_dir',
  buildEvent: (toolName, toolInput, extra) => ({
    event: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    ...extra,
  }),
});

process.exit(ok ? 0 : 1);
