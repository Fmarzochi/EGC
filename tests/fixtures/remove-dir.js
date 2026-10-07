'use strict';

/**
 * Removes a directory a test built, retrying the codes Windows raises while
 * the operating system or a child process still holds a handle on it. A
 * retryable code that survives every attempt leaves the directory in the temp
 * folder with a warning on stderr: a behavior test must not fail because its
 * cleanup lost a race with the system (#1718, #1763). Any other error throws.
 */

const fs = require('fs');

const RETRYABLE_REMOVE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const DEFAULT_ATTEMPTS = 12;
const DEFAULT_DELAY_MS = 100;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function warnOnStderr(message) {
  process.stderr.write(`${message}\n`);
}

function removeDirWithRetries(dir, options = {}) {
  const attempts = options.attempts || DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const rm = options.rm || fs.rmSync;
  const sleep = options.sleep || sleepMs;
  const warn = options.warn || warnOnStderr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      rm(dir, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (!RETRYABLE_REMOVE_CODES.has(error && error.code)) throw error;
      if (attempt === attempts) {
        warn(`[tests] ${dir} left behind: ${error.code} after ${attempts} attempts`);
        return false;
      }
      sleep(delayMs * attempt);
    }
  }
  return false;
}

module.exports = { removeDirWithRetries, RETRYABLE_REMOVE_CODES };
