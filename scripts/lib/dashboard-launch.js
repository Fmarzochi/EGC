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

async function waitForDashboard(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  async function poll() {
    const up = await pingDashboard();
    if (up) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 250));
    return poll();
  }
  return poll();
}

function canOpenBrowser() {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return true;
  }
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function openBrowser() {
  if (!canOpenBrowser()) return false;
  let cmd;
  if (process.platform === 'win32') {
    cmd = 'start';
  } else if (process.platform === 'darwin') {
    cmd = 'open';
  } else {
    cmd = 'xdg-open';
  }
  try {
    const result = spawnSync(cmd, [DASHBOARD_URL], { shell: process.platform === 'win32', stdio: 'ignore' });
    return !result.error && result.status === 0;
  } catch (_) {
    return false;
  }
}

function createLaunchResult(ready, browserOpened) {
  if (!ready) return false;
  return {
    ready: true,
    browserOpened: Boolean(browserOpened),
    toString() { return 'true'; },
    valueOf() { return true; },
    [Symbol.toPrimitive](hint) { return hint === 'string' ? 'true' : true; },
  };
}

// log(msg) receives already-formatted lines so each caller keeps its own
// styling. Resolves once the launch decision is made, never rejects.
async function launchDashboard({ log = () => {} } = {}) {
  // The script to run is derived from this file's own location, never from
  // a caller-supplied root. Every caller (init.js, install-apply.js, the
  // shell wrapper) already resolved the same package root, so nothing
  // changes in practice -- but a path that arrives from outside and reaches
  // spawn() is a command-injection shape no matter how it is escaped, and
  // there is no path left to validate once it cannot arrive at all.
  const dashboardScript = path.join(__dirname, '..', 'dashboard.js');
  if (!fs.existsSync(dashboardScript)) return false;

  try {
    const already = await pingDashboard();
    if (already) {
      log(`Dashboard already running at ${DASHBOARD_URL}`);
      const browserOpened = openBrowser();
      return createLaunchResult(true, browserOpened);
    }
    // No shell, on any platform. Both arguments are absolute paths this
    // process already owns (process.execPath, and a sibling of __dirname),
    // so there is nothing for a shell to resolve. Node's documentation is
    // explicit that shell is only needed for .bat/.cmd files, that detached
    // works on Windows without it, and that enabling it with unsanitized
    // input allows arbitrary command execution.
    const child = spawn(process.execPath, [dashboardScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, EGC_PORT: String(PORT) },
    });
    child.unref();
    log(`EGC Dashboard starting at ${DASHBOARD_URL}`);
    // The spawn above is detached with its output discarded, so this poll
    // is the only honesty available: without it, a server that dies during
    // startup (missing deps in a root-owned prefix, #1233) leaves the
    // success line as the last word while the port refuses connections.
    // The budget covers the child's own path: when every dashboard dep
    // already resolves the server answers in well under 4s, and a first
    // launch in a WRITABLE checkout may run a full npm install first, so
    // announcing failure at 4s there would be a false verdict (PR #1234
    // review). When deps are missing but the directory is not writable
    // (the exact #1233 scenario) no install can run at all: the child
    // refuses within a second, so the long budget would only delay the
    // honest failure line by a minute (post-merge review of #1234).
    const { checkDashboardDeps } = require(path.join(__dirname, 'dashboard-deps'));
    const depsReport = checkDashboardDeps(path.join(__dirname, '..', '..', 'dashboard'));
    const installAhead = depsReport.missing.length > 0 && depsReport.writable && depsReport.manifestError === null;
    if (installAhead) log('First launch may install dashboard dependencies; giving it up to a minute.');
    const budgetMs = installAhead ? 60000 : 4000;
    const ready = await waitForDashboard(budgetMs);
    if (ready) {
      log('Minimize it to keep working. Run `egc dashboard stop` to close.');
      const browserOpened = openBrowser();
      return createLaunchResult(true, browserOpened);
    }
    log(`EGC Dashboard did not respond within ${Math.round(budgetMs / 1000)}s.`);
    log(`See the startup error with: node "${dashboardScript}" start`);
    return false;
  } catch (err) {
    log(`Dashboard startup skipped: ${err.message}`);
    return false;
  }
}

// The dashboard is only worth spawning for a human at an interactive
// terminal; CI runs and scripted installs stay headless.
function shouldAutoLaunch() {
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

module.exports = { launchDashboard, shouldAutoLaunch, waitForDashboard, openBrowser, canOpenBrowser, DASHBOARD_URL };
