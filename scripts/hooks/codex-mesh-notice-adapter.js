#!/usr/bin/env node
'use strict';

// Codex CLI runs the mesh notice as a UserPromptSubmit hook and reads the
// dual-field JSON the shared script prints. This adapter is that script with
// the Team Brain sync at the turn boundary turned on, since Codex has no
// session start or stop hook EGC can use: the same host-adapter pattern as
// trae-mesh-notice-adapter.js. It always exits 0.

const fs = require('node:fs');
const { run, readStdinPayload } = require('./mesh-events-inject');

void (async () => {
  try {
    const notice = run(await readStdinPayload(), { teamSync: true });
    if (notice) {
      fs.writeSync(1, JSON.stringify({
        additionalContext: notice,
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notice },
      }));
    }
  } catch (_) { // NOSONAR: a wake-signal hook must never break the harness turn
    // exit silently below
  }
  process.exit(0);
})();
