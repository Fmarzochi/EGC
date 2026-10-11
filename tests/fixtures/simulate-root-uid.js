'use strict';

/**
 * NODE_OPTIONS=--require preload: makes process.getuid() and
 * process.geteuid() report root (0) on a platform where they exist, so an
 * install-apply.js subprocess under test can be run "as root" without
 * actually needing root. install-apply.js's refusal reads geteuid, the
 * one that decides file ownership; getuid is mocked too for any test or
 * future check that reads the real UID instead. Leaves Windows (neither
 * function exists) alone, since the refusal it is simulating is a
 * Unix-only no-op there.
 */
if (typeof process.getuid === 'function') {
  process.getuid = () => 0;
}
if (typeof process.geteuid === 'function') {
  process.geteuid = () => 0;
}
