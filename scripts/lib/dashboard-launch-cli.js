#!/usr/bin/env node
'use strict';

// Tiny CLI wrapper over dashboard-launch for the shell installers: they
// cannot require() the module directly, and the launch decision must stay
// in one place. No argument is read: launchDashboard resolves the script
// from its own location, so nothing a caller passes can influence what is
// spawned.

const { launchDashboard, shouldAutoLaunch } = require('./dashboard-launch');

if (shouldAutoLaunch()) {
  // launchDashboard resolves rather than rejects on its own failures, but an
  // unexpected rejection here would surface as an UnhandledPromiseRejection
  // and take the installer's exit code with it: a dashboard that did not
  // start is never a reason to fail an otherwise complete installation.
  launchDashboard({ log: (line) => console.log(line) })
    // A rejection value is not guaranteed to be an Error; reading .message
    // off null here would throw inside the handler and reintroduce the very
    // unhandled rejection this catch exists to prevent.
    .catch((err) => console.log(`Dashboard startup skipped: ${err instanceof Error ? err.message : String(err)}`));
} else {
  console.log("Dashboard not started (headless environment). Run 'egc dashboard' to start it.");
}
