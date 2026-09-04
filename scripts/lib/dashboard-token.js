'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The dashboard mints exactly this shape at startup (dashboard/ops.js,
// TOKEN_BYTES hex characters); anything else is a partial write and counts
// as no token, so a sender retries next time instead of posting a token
// the dashboard is sure to refuse.
const DASHBOARD_TOKEN_RE = /^[0-9a-f]{64}$/i;
const DASHBOARD_TOKEN_FILE = 'dashboard-token';

function resolveDashboardTokenPath(homeDir) {
  const home = homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.egc', DASHBOARD_TOKEN_FILE);
}

function readDashboardToken(homeDir) {
  try {
    const raw = fs.readFileSync(resolveDashboardTokenPath(homeDir), 'utf8').trim();
    return DASHBOARD_TOKEN_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

module.exports = { DASHBOARD_TOKEN_FILE, DASHBOARD_TOKEN_RE, readDashboardToken, resolveDashboardTokenPath };
