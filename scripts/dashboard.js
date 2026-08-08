#!/usr/bin/env node
'use strict';

const { spawnSync, spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');
const SERVER_SCRIPT = path.join(DASHBOARD_DIR, 'server.js');
const PORT_HELPER   = path.join(DASHBOARD_DIR, 'port');
const PID_FILE = path.join(require('node:os').homedir(), '.egc', 'dashboard.pid');

const args = process.argv.slice(2);
const flag = args[0];

// Resolve port lazily so a missing dashboard directory produces the friendly
// "EGC Dashboard not found" error instead of a MODULE_NOT_FOUND crash.
function getPort() {
  return require(PORT_HELPER).PORT;
}

function isRunning() {
  const port = getPort();
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${port}/ping`, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

function openBrowser() {
  const url = `http://localhost:${getPort()}`;
  let cmd;
  if (process.platform === 'win32') {
    cmd = 'start';
  } else if (process.platform === 'darwin') {
    cmd = 'open';
  } else {
    cmd = 'xdg-open';
  }
  try {
    spawnSync(cmd, [url], { shell: process.platform === 'win32', stdio: 'ignore' });
  } catch (_) { /* browser open is best-effort */ } // NOSONAR
}

function writePid(pid) {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(pid));
  } catch (_) { /* pid file is optional */ } // NOSONAR
}

function readPid() {
  try { return Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); } catch (_) { return null; } // NOSONAR: missing or unreadable PID file simply means not running
}

async function start() {
  if (!fs.existsSync(SERVER_SCRIPT)) {
    console.error('EGC Dashboard not found. Expected: ' + SERVER_SCRIPT);
    process.exit(1);
  }

  const PORT = getPort();

  // The server's own require() resolves dependencies by walking up from
  // dashboard/, so they may live in dashboard/node_modules (git checkout
  // with a local install) or in the package root's node_modules (global
  // npm install: express and ws are root dependencies). Only when neither
  // resolves is an on-demand install attempted, and only where it can
  // succeed: inside a root-owned global prefix, npm install can only die
  // with EACCES behind the detached spawn, which is how #1233 was hit.
  const depsResolve = ['express', 'ws'].every(dep => {
    try { require.resolve(dep, { paths: [DASHBOARD_DIR] }); return true; } catch (_) { return false; } // NOSONAR: unresolved simply routes to the install below
  });
  if (!depsResolve) {
    let writable = true;
    try { fs.accessSync(DASHBOARD_DIR, fs.constants.W_OK); } catch (_) { writable = false; } // NOSONAR: probe only
    if (!writable) {
      console.error('Dashboard dependencies are missing and the package directory is not writable:');
      console.error('  ' + DASHBOARD_DIR);
      console.error('Update EGC to a release that ships them preinstalled, or install them once with:');
      console.error('  sudo npm --prefix "' + DASHBOARD_DIR + '" install');
      process.exit(1);
    }
    console.log('Installing dashboard dependencies...');
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], {
      cwd: DASHBOARD_DIR, stdio: 'inherit',
    });
    if (r.status !== 0) { console.error('npm install failed.'); process.exit(1); }
  }

  const already = await isRunning();
  if (already) {
    console.log(`EGC Dashboard already running at http://localhost:${PORT}`);
    openBrowser();
    return;
  }

  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: DASHBOARD_DIR,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, EGC_PORT: String(PORT) },
  });
  child.unref();
  writePid(child.pid);

  // Wait up to 3s for server to accept connections
  const deadline = Date.now() + 3000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    if (await isRunning()) { ready = true; break; }
  }

  if (!ready) {
    console.error('EGC Dashboard failed to start. Check server.js for errors.');
    process.exit(1);
  }
  console.log(`EGC Dashboard running at http://localhost:${PORT}`);
  openBrowser();
}

async function stop() {
  const pid = readPid();
  if (!pid) {
    const already = await isRunning();
    if (!already) { console.log('Dashboard is not running.'); return; }
    console.error('No PID file found. Stop the server manually.');
    return;
  }
  try {
    process.kill(pid, 0);
  } catch (_) { // NOSONAR: kill(pid, 0) throwing means the process is already gone; stale PID is cleaned below
    try { fs.unlinkSync(PID_FILE); } catch (__) { /* pid file is optional */ } // NOSONAR
    if (!await isRunning()) { console.log('Dashboard is not running (stale PID cleaned up).'); return; }
    console.error('No PID file found. Stop the server manually.');
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(PID_FILE);
    console.log(`Dashboard stopped (pid ${pid}).`);
  } catch (e) {
    console.error('Failed to stop dashboard:', e.message);
  }
}

async function status() {
  const running = await isRunning();
  const pid = readPid();
  const PORT = getPort();
  if (running) {
    console.log(`running  http://localhost:${PORT}${pid ? '  (pid ' + pid + ')' : ''}`);
  } else {
    console.log('stopped');
  }
}

(async () => {
  if (flag === '--stop' || flag === 'stop') return stop();
  if (flag === '--status' || flag === 'status') return status();
  if (flag === '--help' || flag === '-h') {
    console.log('Usage: egc dashboard [stop|status]');
    console.log('  (no args)  Start dashboard and open browser');
    console.log('  stop       Stop the background server');
    console.log('  status     Show whether the server is running');
    return;
  }
  await start();
})();
