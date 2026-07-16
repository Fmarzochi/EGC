#!/usr/bin/env node
'use strict';

const { spawnSync, spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const PORT = 7890;
const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');
const SERVER_SCRIPT = path.join(DASHBOARD_DIR, 'server.js');
const PID_FILE = path.join(require('node:os').homedir(), '.egc', 'dashboard.pid');

const args = process.argv.slice(2);
const flag = args[0];

function isRunning() {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${PORT}/ping`, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

function openBrowser() {
  const url = `http://localhost:${PORT}`;
  const cmd = process.platform === 'win32' ? 'start' :
               process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawnSync(cmd, [url], { shell: process.platform === 'win32', stdio: 'ignore' });
  } catch (_) { /* browser open is best-effort */ }
}

function writePid(pid) {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(pid));
  } catch (_) { /* pid file is optional */ }
}

function readPid() {
  try { return Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); } catch (_) { return null; }
}

async function start() {
  if (!fs.existsSync(SERVER_SCRIPT)) {
    console.error('EGC Dashboard not found. Expected: ' + SERVER_SCRIPT);
    process.exit(1);
  }

  const nmDir = path.join(DASHBOARD_DIR, 'node_modules');
  if (!fs.existsSync(nmDir)) {
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
  } catch (_) {
    try { fs.unlinkSync(PID_FILE); } catch (__) { /* pid file is optional */ }
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
  if (running) {
    console.log(`running  http://localhost:${PORT}${pid ? `  (pid ${pid})` : ''}`);
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
