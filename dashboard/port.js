'use strict';

/**
 * Shared dashboard port helper.
 *
 * Read once at require-time so every module in the same process sees the same
 * value.  Consumers just do:
 *
 *   const { PORT } = require('./port');
 *
 * Set EGC_PORT in the environment to override the default:
 *
 *   EGC_PORT=8123 egc dashboard
 */

const raw = process.env.EGC_PORT;

// Require the value to be a pure integer string (no leading/trailing chars).
// parseInt('8123abc', 10) would silently return 8123, so we validate first.
const parsed = (raw !== undefined && raw !== '' && /^\d+$/.test(raw))
  ? Number(raw)
  : NaN;

if (raw !== undefined && raw !== '' && (Number.isNaN(parsed) || parsed < 1 || parsed > 65535)) {
  process.stderr.write(
    `[EGC] Warning: EGC_PORT="${raw}" is not a valid port number. Falling back to 7890.\n`
  );
}

const PORT = (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 65535) ? parsed : 7890;

module.exports = { PORT };
