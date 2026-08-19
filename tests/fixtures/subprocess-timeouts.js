'use strict';

/**
 * Timeouts for tests that spawn a real EGC command as a subprocess.
 *
 * A suite that runs a complete install-apply against a temp tree performs
 * dozens of file writes, and every runner environment adds its own tax: a
 * Windows machine pays antivirus scanning per write, and a busy hosted
 * Linux runner pays CPU contention and cold process starts (three ubuntu
 * occurrences on 2026-08-19 alone: a cold pwsh start plus a full dry-run
 * plan overran the old 10s budget, and the killed subprocess's null exit
 * status surfaced as a mute `1 !== 0` failure). A budget sized on a quiet
 * machine reads as a flake and is not one: the work genuinely takes longer
 * there.
 *
 * The budget therefore no longer varies by platform: a timeout here is a
 * last-resort hang detector, not a performance assertion.
 *
 * Kept in one place so the next adjustment is a single edit rather than a
 * hunt through every suite.
 */

// For suites that install or uninstall a target end to end.
const FULL_INSTALL_TIMEOUT_MS = 90000;

// For suites that only spawn a CLI to read output (--help, --json probes).
const CLI_TIMEOUT_MS = 30000;

module.exports = { FULL_INSTALL_TIMEOUT_MS, CLI_TIMEOUT_MS };
