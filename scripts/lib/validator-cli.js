'use strict';

// Shared CLI runner boilerplate for scripts/ci/validate-*.js. Nine of the
// eleven validate-*.js scripts independently reimplemented the same outer
// shape: skip cleanly with a console.log + exit(0) when there is nothing to
// validate, then, after each script's own file collection and per-item
// checks accumulate their own errors, exit(1) on failure or print a success
// summary (EGC-539 audit, scripts/ finding). This module centralizes only
// that outer shape; each validator keeps its own item collection and
// per-item validation, since those genuinely differ (recursive vs. flat
// directory walk, single hasErrors accumulator vs. hasErrors+warnCount,
// etc.) and forcing them through one generic loop would hide real
// behavioral differences instead of removing duplicated ones.
//
// scripts/ci/check-unicode-safety.js and scripts/ci/validate-workflow-security.js
// are deliberately NOT migrated to this module -- see the comments in those
// files and the PR description for why forcing them in would distort
// behavior that is genuinely different, not just duplicated.

const fs = require('node:fs');

/**
 * Skip validation cleanly when a required input does not exist: prints
 * `message` via console.log and exits 0. Accepts a single path or an array
 * of paths that must ALL exist (skips if ANY is missing), matching
 * validate-install-manifests.js's "either manifest missing" check.
 *
 * Returns without exiting when every path exists, so callers use it as a
 * plain guard clause at the top of their validator's entry function.
 *
 * @param {string|string[]} requiredPaths
 * @param {string} message
 */
function skipIfMissing(requiredPaths, message) {
  const paths = Array.isArray(requiredPaths) ? requiredPaths : [requiredPaths];
  if (paths.some(p => !fs.existsSync(p))) {
    console.log(message);
    process.exit(0);
  }
}

/**
 * Finish a validator run: exit 1 if the caller accumulated any errors,
 * otherwise print the success summary. Falls through to a normal process
 * end (exit code 0) when there are no errors, exactly like the
 * hand-written `if (hasErrors) { process.exit(1); } console.log(...)` tail
 * every validator used to repeat.
 *
 * @param {boolean} hasErrors
 * @param {string} successMessage
 */
function finishValidation(hasErrors, successMessage) {
  if (hasErrors) {
    process.exit(1);
  }
  console.log(successMessage);
}

module.exports = { skipIfMissing, finishValidation };
