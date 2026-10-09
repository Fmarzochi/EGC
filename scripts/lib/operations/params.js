'use strict';

/**
 * scripts/lib/operations/params.js
 *
 * Input validation shared by the operations in index.js and session-bus.js.
 */

/**
 * Normalise the params argument so downstream code never receives null/undefined.
 * CodeRabbit finding: passing null throws TypeError inside downstream libs.
 */
function normalizeParams(params) {
  if (params === null || params === undefined) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('Operation params must be a plain object');
  }
  return params;
}

module.exports = { normalizeParams };
