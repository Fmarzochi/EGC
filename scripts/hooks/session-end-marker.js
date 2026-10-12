#!/usr/bin/env node
'use strict';

/**
 * Session end marker hook - performs lightweight observer cleanup and
 * outputs stdin to stdout unchanged. Exports run() for in-process execution.
 */

const {
  resolveProjectContext,
  removeSessionLease,
  listSessionLeases,
  stopObserverForContext,
  resolveSessionId
} = require('../lib/observer-sessions');
const { readHookStdin } = require('../lib/hook-stdin');

function log(message) {
  process.stderr.write(`[SessionEnd] ${message}\n`);
}

function run(output = '') {
  const sessionId = resolveSessionId();

  if (!sessionId) {
    log('No EGC_SESSION_ID available; skipping observer cleanup');
    return output;
  }

  try {
    const observerContext = resolveProjectContext();
    removeSessionLease(observerContext, sessionId);
    const remainingLeases = listSessionLeases(observerContext);

    if (remainingLeases.length === 0) {
      if (stopObserverForContext(observerContext)) {
        log(`Stopped observer for project ${observerContext.projectId} after final session lease ended`);
      } else {
        log(`No running observer to stop for project ${observerContext.projectId}`);
      }
    } else {
      log(`Retained observer for project ${observerContext.projectId}; ${remainingLeases.length} session lease(s) remain`);
    }
  } catch (err) {
    log(`Observer cleanup skipped: ${err.message}`);
  }

  return output;
}

// Legacy CLI execution (when run directly)
if (require.main === module) {
  readHookStdin(({ raw }) => {
    process.stdout.write(run(raw));
  });
}

module.exports = { run };
