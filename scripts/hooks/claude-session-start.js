#!/usr/bin/env node
'use strict';

// Claude's thin SessionStart wrapper: the shared adapter reads state and emits
// telemetry; Claude receives the restored context through stdout.

let restored = { host: 'claude', context: '' };
try {
  const { runSessionStartAdapter } = require('../lib/session-start-adapter');
  restored = runSessionStartAdapter({ host: 'claude', projectEnv: 'CLAUDE_PROJECT_DIR' });
} catch (_) { // NOSONAR: never block Claude session startup
  // Keep the empty fallback above.
}

if (typeof restored.context === 'string' && restored.context) {
  process.stdout.write(restored.context);
}
