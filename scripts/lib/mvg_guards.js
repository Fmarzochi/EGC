'use strict';

/**
 * MVG Guards - Pragmatic runtime protection for EGC
 */

const fs = require('node:fs');
const { log } = require('./utils');

const MAX_ACTIVATION_DEPTH = 3;

/**
 * Check for recursive activation storms.
 * Uses a session-scoped counter in /tmp to track depth.
 */
function checkRecursion(sessionId) {
  if (!sessionId || sessionId === 'unknown') return;

  const lockFile = `/tmp/egc-recursion-${sessionId}.lock`;
  let depth = 0;

  try {
    if (fs.existsSync(lockFile)) {
      depth = Number.parseInt(fs.readFileSync(lockFile, 'utf8')) || 0;
    }

    if (depth >= MAX_ACTIVATION_DEPTH) {
      log(`[MVG] Recursion detected. Depth: ${depth}. FREEZING.`);
      throw new Error(`CRITICAL: Activation depth limit reached (${MAX_ACTIVATION_DEPTH}).`);
    }

    fs.writeFileSync(lockFile, (depth + 1).toString(), 'utf8');
  } catch (err) {
    if (err.message.includes('depth limit')) throw err;
    // Silent fail on IO errors to avoid blocking the main runtime unnecessarily
  }
}

/**
 * Reset recursion counter (call at start of turn or session)
 */
function resetRecursion(sessionId) {
  if (!sessionId) return;
  const lockFile = `/tmp/egc-recursion-${sessionId}.lock`;
  try {
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch {
    // Intentional: best-effort cleanup of recursion lock; absent or unwritable file is a no-op.
  }
}

module.exports = {
  checkRecursion,
  resetRecursion,
  MAX_ACTIVATION_DEPTH
};
