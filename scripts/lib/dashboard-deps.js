'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Reads the dashboard's dependency list from its own package.json (single
// source of truth, so no gate can drift from the manifest) and reports
// which dependencies fail to resolve from the dashboard directory. The
// server's require() walks up from dashboard/, so a dependency may live in
// dashboard/node_modules (git checkout with a local install) or in the
// package root's node_modules (global npm install ships them at the root).
function checkDashboardDeps(dashboardDir) {
  // Whether an on-demand `npm install` inside dashboardDir could even
  // succeed. In a root-owned global prefix it cannot (#1233), and callers
  // use this to pick between a long install budget and a fast refusal.
  let writable = true;
  try { fs.accessSync(dashboardDir, fs.constants.W_OK); } catch (_) { writable = false; } // NOSONAR: probe only

  let deps;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dashboardDir, 'package.json'), 'utf8'));
    deps = Object.keys(manifest.dependencies || {});
  } catch (err) {
    return { deps: [], missing: [], manifestError: err, writable };
  }
  const missing = deps.filter(dep => {
    try { require.resolve(dep, { paths: [dashboardDir] }); return false; } catch (_) { return true; } // NOSONAR: an unresolved dep is the datum being collected
  });
  return { deps, missing, manifestError: null, writable };
}

module.exports = { checkDashboardDeps };
