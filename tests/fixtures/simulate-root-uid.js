'use strict';

/**
 * NODE_OPTIONS=--require preload: makes process.getuid() report root (0)
 * on a platform where it exists, so an install-apply.js subprocess under
 * test can be run "as root" without actually needing root. Leaves Windows
 * (no process.getuid) alone, since the refusal it is simulating is a
 * Unix-only no-op there.
 */
if (typeof process.getuid === 'function') {
  process.getuid = () => 0;
}
