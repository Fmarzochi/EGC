'use strict';

// Trae feeds a UserPromptSubmit hook's PLAIN-TEXT stdout to the model as
// additional context (docs.trae.ai/ide/hook-configuration-reference: "Plain
// text: The output will be provided to the model as additional context.
// This format is only applicable to the SessionStart and UserPromptSubmit
// events"), while its structured-JSON stdout channel is for workflow
// control (block decisions), not context injection. The generic hooks.json
// merge registers a bare `node <script>` command with no room for flags, so
// this tiny adapter IS the flag: it delegates to the shared implementation
// and prints the bare notice, same host-adapter pattern as
// kiro-guardian-adapter.js and windsurf-guardian-adapter.js.

const fs = require('node:fs');
const { run, readStdinPayload } = require('./mesh-events-inject');

try {
  const notice = run(readStdinPayload());
  if (notice) {
    fs.writeSync(1, notice);
  }
} catch (_) { // NOSONAR: a wake-signal hook must never break the harness turn
  // exit silently below
}
process.exit(0);
