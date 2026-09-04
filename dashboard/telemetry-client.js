'use strict';

const http = require('http');

const { readDashboardToken } = require('../scripts/lib/dashboard-token');

const TOKEN_HEADER = 'x-egc-token';

function postEvent(ev, { port, timeout = 300, onDone } = {}) {
  const body = JSON.stringify(ev);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  const token = readDashboardToken();
  if (token) headers[TOKEN_HEADER] = token;
  // A timed-out request also raises an error when it is destroyed: the
  // completion callback fires once regardless.
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    if (typeof onDone === 'function') onDone();
  };
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
