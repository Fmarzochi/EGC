'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TOKEN_HEADER = 'x-egc-token';

// The dashboard mints this token at startup (dashboard/ops.js) and keeps it
// private to the user; every local telemetry sender presents it, so a web
// page in the same browser cannot post events blind.
function readDashboardToken(homeDir) {
  const home = homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir();
  try {
    const raw = fs.readFileSync(path.join(home, '.egc', 'dashboard-token'), 'utf8').trim();
    return /^[0-9a-f]{32,}$/i.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function postEvent(ev, { port, timeout = 300, onDone } = {}) {
  const body = JSON.stringify(ev);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  const token = readDashboardToken();
  if (token) headers[TOKEN_HEADER] = token;
  const done = typeof onDone === 'function' ? onDone : () => {};
  const req = http.request(
    { hostname: '127.0.0.1', port, path: '/event', method: 'POST', headers, timeout },
    res => {
      res.resume();
      done();
    }
  );
  req.on('error', () => done());
  req.on('timeout', () => {
    req.destroy();
    done();
  });
  req.end(body);
  return req;
}

module.exports = { TOKEN_HEADER, postEvent, readDashboardToken };
