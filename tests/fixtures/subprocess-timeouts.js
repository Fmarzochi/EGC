'use strict';

/**
 * Timeouts for tests that spawn a real EGC command as a subprocess.
 *
 * A suite that runs a complete install-apply against a temp tree performs
 * dozens of file writes, and on a Windows runner each one also pays for
 * whatever the machine's antivirus does with it. A budget sized on a quiet
 * machine turns that into `spawnSync node ETIMEDOUT`, which reads as a flake
 * and is not one: the work genuinely takes longer there.
 *
 * Kept in one place so the next adjustment is a single edit rather than a
 * hunt through every suite.
 */

// For suites that install or uninstall a target end to end.
const FULL_INSTALL_TIMEOUT_MS = process.platform === 'win32' ? 90000 : 10000;

// For suites that only spawn a CLI to read output (--help, --json probes).
const CLI_TIMEOUT_MS = process.platform === 'win32' ? 30000 : 10000;

module.exports = { FULL_INSTALL_TIMEOUT_MS, CLI_TIMEOUT_MS };
