#!/usr/bin/env node
'use strict';

// Tiny CLI wrapper over dashboard-launch for the shell installers: they
// cannot require() the module directly, and the launch decision must stay
// in one place. argv[2] is the repo/package root the dashboard runs from.

const path = require('node:path');
const { launchDashboard, shouldAutoLaunch } = require('./dashboard-launch');

const rootDir = process.argv[2] || path.join(__dirname, '..', '..');

if (shouldAutoLaunch()) {
  // launchDashboard resolves rather than rejects on its own failures, but an
  // unexpected rejection here would surface as an UnhandledPromiseRejection
  // and take the installer's exit code with it: a dashboard that did not
  // start is never a reason to fail an otherwise complete installation.
  launchDashboard({ rootDir, log: (line) => console.log(line) })
    .catch((err) => console.log(`Dashboard startup skipped: ${err.message}`));
} else {
  console.log("Dashboard not started (headless environment). Run 'egc dashboard' to start it.");
}
