#!/usr/bin/env node
'use strict';

// OpenCode's thin child-process bridge: the shared adapter syncs the Team
// Brain when asked, restores state and emits telemetry; the plugin consumes
// the serialized result and injects it.

async function main() {
  let restored = { host: 'opencode', context: '' };
  try {
    const { runSessionStartAdapter } = require('../lib/session-start-adapter');
    restored = await runSessionStartAdapter({ host: 'opencode', projectEnv: 'OPENCODE_PROJECT_DIR' });
  } catch (_) { // NOSONAR: keep the bridge fail-open
    // Keep the empty fallback above.
  }

  process.stdout.write(JSON.stringify(restored));
}

main();
