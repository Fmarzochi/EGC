'use strict';

// Shared dashboard launcher for `egc init` and `egc install`: pings the
// local dashboard, starts it detached when absent, and opens the browser.
// Never throws; installation must not fail because a browser could not open.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { PORT } = require(path.join(__dirname, '..', '..', 'dashboard', 'port'));

const DASHBOARD_URL = `http://localhost:${PORT}`;

function pingDashboard() {
  return new Promise(resolve => {
    const req = http.get(`${DASHBOARD_URL}/ping`, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(500, () => { req.destroy(); resolve(false); });
  });
}

function openBrowser() {
  let cmd;
  if (process.platform === 'win32') {
    cmd = 'start';
  } else if (process.platform === 'darwin') {
    cmd = 'open';
  } else {
    cmd = 'xdg-open';
  }
  try { spawnSync(cmd, [DASHBOARD_URL], { shell: process.platform === 'win32', stdio: 'ignore' }); } catch (_) { /* ignore: best-effort browser open, failure is non-fatal */ } // NOSONAR
}

// log(msg) receives already-formatted lines so each caller keeps its own
// styling. Resolves once the launch decision is made, never rejects.
function launchDashboard({ rootDir, log = () => {} }) {
  const dashboardScript = path.join(rootDir, 'scripts', 'dashboard.js');
  if (!fs.existsSync(dashboardScript)) return Promise.resolve(false);

  return pingDashboard().then(already => {
    if (already) {
      log(`Dashboard already running at ${DASHBOARD_URL}`);
      openBrowser();
      return true;
    }
    const child = spawn(process.execPath, [dashboardScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, EGC_PORT: String(PORT) },
      ...(process.platform === 'win32' && { shell: true }),
    });
    child.unref();
    log(`EGC Dashboard starting at ${DASHBOARD_URL}`);
    log('Minimize it to keep working. Run `egc dashboard stop` to close.');
    setTimeout(openBrowser, 1500);
    return true;
  }).catch(err => {
    log(`Dashboard startup skipped: ${err.message}`);
    return false;
  });
}

// The dashboard is only worth spawning for a human at an interactive
// terminal; CI runs and scripted installs stay headless.
function shouldAutoLaunch() {
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

module.exports = { launchDashboard, shouldAutoLaunch, DASHBOARD_URL };
