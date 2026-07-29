/**
 * Tests for scripts/hooks/amazonq-guardian-adapter.js
 *
 * Amazon Q's preToolUse hook wire contract -- {hook_event_name, cwd,
 * tool_name, tool_input} on stdin, exit code 2 to block -- is byte-for-byte
 * the same shape Kiro's CLI uses (see kiro-guardian-adapter.test.js). Case
 * bodies are shared with the other two EGC-498-corrected hosts via
 * guardian-adapter-test-harness.js (see that file for the case list).
 */

const path = require('path');
const { runGuardianAdapterTests } = require('./guardian-adapter-test-harness');

const adapterScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'amazonq-guardian-adapter.js');
const { buildGuardianInput } = require(adapterScript);

const ok = runGuardianAdapterTests({
  suiteLabel: 'amazonq-guardian-adapter',
  adapterScript,
  buildGuardianInput,
  shellToolName: 'execute_bash',
  nonShellToolName: 'fs_write',
  cwdKey: 'cwd',
  buildEvent: (toolName, toolInput, extra) => ({
    hook_event_name: 'preToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    ...extra,
  }),
});

process.exit(ok ? 0 : 1);
