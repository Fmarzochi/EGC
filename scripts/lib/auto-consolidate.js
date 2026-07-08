'use strict';

const fs = require('node:fs');
const os = require('node:os');

const { consolidateState, backupStateFile, DEFAULT_THRESHOLD } = require('./state-consolidate');
const { isEncryptedBuffer } = require('./state-crypto');

const AUTO_CONSOLIDATE_ENV = 'EGC_AUTO_CONSOLIDATE';

/**
 * Compacts a project state file in place when it grows past the layered
 * summary threshold. Backs the original up to the state archive first, so
 * the automatic path is as safe as running `egc consolidate` by hand.
 * Disabled with EGC_AUTO_CONSOLIDATE=0.
 */
function autoConsolidateStateFile(filePath, options = {}) {
  if (String(process.env[AUTO_CONSOLIDATE_ENV] || '1') === '0') {
    return { consolidated: false, reason: 'disabled' };
  }
  if (!fs.existsSync(filePath)) {
    return { consolidated: false, reason: 'missing' };
  }

  let content;
  try {
    const raw = fs.readFileSync(filePath);
    // Encrypted state belongs to the memory server; rewriting it here would
    // destroy the ciphertext and its HMAC sidecar.
    if (isEncryptedBuffer(raw)) {
      return { consolidated: false, reason: 'encrypted' };
    }
    content = raw.toString('utf8');
  } catch {
    return { consolidated: false, reason: 'unreadable' };
  }

  const result = consolidateState(content, {
    threshold: options.threshold || DEFAULT_THRESHOLD,
    now: options.now,
  });
  if (!result.needed || result.linesAfter >= result.linesBefore) {
    return { consolidated: false, reason: 'below-threshold' };
  }

  const homeDir = options.homeDir || os.homedir();
  let backupPath = null;
  try {
    backupPath = backupStateFile(homeDir, filePath, options.now);
    fs.writeFileSync(filePath, result.output, 'utf8');
  } catch {
    return { consolidated: false, reason: 'write-failed', backupPath };
  }

  return {
    consolidated: true,
    linesBefore: result.linesBefore,
    linesAfter: result.linesAfter,
    backupPath,
  };
}

module.exports = {
  AUTO_CONSOLIDATE_ENV,
  autoConsolidateStateFile,
};
