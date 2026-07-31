#!/usr/bin/env node
'use strict';

// OpenCode's thin child-process bridge: the shared adapter restores state and
// emits telemetry; the plugin consumes the serialized result and injects it.

let restored = { host: 'opencode', context: '' };
try {
  const { runSessionStartAdapter } = require('../lib/session-start-adapter');
  restored = runSessionStartAdapter({ host: 'opencode', projectEnv: 'OPENCODE_PROJECT_DIR' });
} catch (_) { // NOSONAR: keep the bridge fail-open
  // Keep the empty fallback above.
}

process.stdout.write(JSON.stringify(restored));
