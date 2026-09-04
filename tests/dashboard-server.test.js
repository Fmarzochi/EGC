'use strict';
/**
 * Regression tests for Fmarzochi/EGC#500
 *
 * Exercises the real createAccumulator() factory shared with
 * dashboard/server.js so these tests guard the production fix.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point HOME at a scratch directory before the server resolves it, so the
// dashboard token it mints never touches the real ~/.egc.
const SANDBOX_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'egc-dashboard-home-')));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;

const { createAccumulator } = require('../dashboard/accumulator');
const { TOKEN_HEADER, resolveTokenPath } = require('../dashboard/ops');
const { PORT: PANEL_PORT } = require('../dashboard/port');
const WebSocket = require(require.resolve('ws', { paths: [path.join(__dirname, '..', 'dashboard')] }));

function dashboardToken() {
  return fs.readFileSync(resolveTokenPath(), 'utf8').trim();
}

// ---------------------------------------------------------------------------
// Tests — every scenario that should be caught by the guard clause
// ---------------------------------------------------------------------------

test('valid event with ide string creates provider state and counts tool calls', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  assert.equal(Object.keys(providerState).length, 0);

  accumulateEvent({ ide: 'claude', event: 'pre_tool' });

  assert.ok(providerState.claude, 'provider state should exist for claude');
  assert.equal(providerState.claude.ide, 'claude');
  assert.equal(providerState.claude.toolCalls, 1);
  assert.ok(providerState.claude.running, 'provider should be marked running');
});

test('event without ide property does not create provider state', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  accumulateEvent({ event: 'pre_tool' });
  assert.equal(Object.keys(providerState).length, 0);
});

test('event with explicitly undefined ide does not create provider state', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  accumulateEvent({ ide: undefined, event: 'pre_tool' });
  assert.equal(Object.keys(providerState).length, 0);
});

test('event with empty string ide does not create provider state', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  accumulateEvent({ ide: '', event: 'pre_tool' });
  assert.equal(Object.keys(providerState).length, 0);
});

test('event with numeric ide does not create provider state (typeof check)', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  accumulateEvent({ ide: 42, event: 'pre_tool' });
  assert.equal(Object.keys(providerState).length, 0);
});

test('null event argument does not crash and creates no state', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  accumulateEvent(null);
  assert.equal(Object.keys(providerState).length, 0);
});

test('undefined event argument does not crash and creates no state', () => {
  const { providerState, accumulateEvent } = createAccumulator();
  accumulateEvent(undefined);
  assert.equal(Object.keys(providerState).length, 0);
});

test('multiple valid events accumulate on the same provider', () => {
  const { providerState, accumulateEvent } = createAccumulator();

  accumulateEvent({ ide: 'claude', event: 'pre_tool' });
  accumulateEvent({ ide: 'claude', event: 'pre_tool' });
  accumulateEvent({ ide: 'claude', event: 'pre_tool' });

  assert.equal(providerState.claude.toolCalls, 3);
  assert.equal(Object.keys(providerState).length, 1,
    'only one provider should exist');
});

test('valid event returns true', () => {
  const { accumulateEvent } = createAccumulator();
  assert.equal(accumulateEvent({ ide: 'gemini', event: 'pre_tool' }), true);
});

test('invalid event returns false (broadcast guard)', () => {
  const { accumulateEvent } = createAccumulator();
  assert.equal(accumulateEvent({ event: 'pre_tool' }), false);
  assert.equal(accumulateEvent(null), false);
  assert.equal(accumulateEvent(undefined), false);
  assert.equal(accumulateEvent({ ide: '' }), false);
  assert.equal(accumulateEvent({ ide: 42 }), false);
});


test('replay stores file path from detail-shaped file-edit event', () => {
  const { accumulateEvent, getReplayEvents } = createAccumulator();

  accumulateEvent({
    ide: 'claude',
    event: 'pre_tool',
    tool: 'Edit',
    detail: '/workspace/src/app.js',
    session_id: 'detail-file-path-test',
  });

  const replay = getReplayEvents('detail-file-path-test');

  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].file, '/workspace/src/app.js');
});

// ---------------------------------------------------------------------------
// HTTP Server Payload Cap Regression Test Case (Live POST verification)
// ---------------------------------------------------------------------------

function runWithDashboardServer(testFn, done) {
  const originalCreateServer = http.createServer;
  const originalSetInterval = global.setInterval;
  const originalWatchFile = fs.watchFile;
  
  let serverHandler = null;
  const activeIntervals = [];
  const watchedFiles = [];

  // Listeners the server attaches to its http.Server (the WebSocket upgrade
  // among them) are replayed onto the real test server below.
  const serverListeners = [];
  http.createServer = (handler) => {
    serverHandler = handler;
    return { listen: () => {}, on: (event, listener) => { serverListeners.push([event, listener]); } };
  };

  global.setInterval = (cb, ms) => {
    const timerId = originalSetInterval(cb, ms);
    activeIntervals.push(timerId);
    return timerId;
  };

  fs.watchFile = (filename, options, listener) => {
    watchedFiles.push(filename);
    if (typeof options === 'function') {
      originalWatchFile(filename, {}, options);
    } else {
      originalWatchFile(filename, options, listener);
    }
  };

  try {
    delete require.cache[require.resolve('../dashboard/server.js')];
    require('../dashboard/server.js');
  } catch (err) {
    http.createServer = originalCreateServer;
    global.setInterval = originalSetInterval;
    fs.watchFile = originalWatchFile;
    return done(err);
  } finally {
    http.createServer = originalCreateServer;
    global.setInterval = originalSetInterval;
    fs.watchFile = originalWatchFile;
  }

  const cleanupHandles = () => {
    activeIntervals.forEach(id => clearInterval(id));
    watchedFiles.forEach(file => fs.unwatchFile(file));
  };

  if (typeof serverHandler !== 'function') {
    cleanupHandles();
    return done(new Error('Failed to intercept dashboard server route handler logic'));
  }

  const testServer = http.createServer(serverHandler);
  for (const [event, listener] of serverListeners) testServer.on(event, listener);
  let finished = false;

  const cleanup = (err) => {
    if (finished) return;
    finished = true;
    testServer.close(() => {
      cleanupHandles();
      done(err);
    });
  };

  testServer.on('error', (err) => {
    cleanup(err);
  });

  testServer.listen(0, '127.0.0.1', () => {
    const DYNAMIC_PORT = testServer.address().port;
    try {
      testFn(DYNAMIC_PORT, cleanup);
    } catch (err) {
      cleanup(err);
    }
  });
}

test('POST /event rejects payloads larger than 256 KB with 413 status code', (t, done) => {
  runWithDashboardServer((port, cleanup) => {
    const payloadSize = 300 * 1024;
    const largePayload = JSON.stringify({
      ide: 'claude',
      event: 'pre_tool',
      padding: 'a'.repeat(payloadSize)
    });

    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/event',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(largePayload),
        [TOKEN_HEADER]: dashboardToken()
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 413, 'Server must reject large inputs with 413 Status');
          const body = JSON.parse(responseData);
          assert.equal(body.error, 'Payload too large', 'Error response should explicitly match design expectations');
          cleanup();
        } catch (err) {
          cleanup(err);
        }
      });
    });

    req.on('error', (err) => {
      if (err.code === 'ECONNRESET') {
        cleanup(new Error('Connection reset before 413 response was fully processed - server may not be sending the expected rejection'));
      } else {
        cleanup(err);
      }
    });

    req.write(largePayload);
    req.end();
  }, done);
});

test('POST /event rejects malformed JSON with 400 status code', (t, done) => {
  runWithDashboardServer((port, cleanup) => {
    const malformedPayload = '{"ide":"claude","event":';

    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/event',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(malformedPayload),
        [TOKEN_HEADER]: dashboardToken()
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 400, 'Server must reject malformed JSON with 400 Status');
          const body = JSON.parse(responseData);
          assert.equal(typeof body.error, 'string', 'Error message must be a string');
          assert.ok(body.error.length > 0, 'Error message must not be empty');
          cleanup();
        } catch (err) {
          cleanup(err);
        }
      });
    });

    req.on('error', (err) => {
      cleanup(err);
    });

    req.write(malformedPayload);
    req.end();
  }, done);
});

test('POST /event still accepts valid JSON with 200 status code', (t, done) => {
  runWithDashboardServer((port, cleanup) => {
    const validPayload = JSON.stringify({ ide: 'claude', event: 'pre_tool' });

    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/event',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(validPayload),
        [TOKEN_HEADER]: dashboardToken()
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 200, 'Server must accept valid JSON with 200 Status');
          const body = JSON.parse(responseData);
          assert.equal(body.ok, true, 'Response body must contain ok: true');
          cleanup();
        } catch (err) {
          cleanup(err);
        }
      });
    });

    req.on('error', (err) => {
      cleanup(err);
    });

    req.write(validPayload);
    req.end();
  }, done);
});

test('POST /event handles multi-byte UTF-8 character split across TCP chunks', (t, done) => {
  runWithDashboardServer((port, cleanup) => {
    const payload = JSON.stringify({ ide: 'claude', event: 'pre_tool', text: '\u00E9' });
    const buf = Buffer.from(payload, 'utf8');

    const charIndex = payload.indexOf('\u00E9');
    const byteBeforeChar = Buffer.byteLength(payload.slice(0, charIndex), 'utf8');
    const splitPoint = byteBeforeChar + 1;

    const chunk1 = buf.subarray(0, splitPoint);
    const chunk2 = buf.subarray(splitPoint);

    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/event',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        [TOKEN_HEADER]: dashboardToken()
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 200, 'Split multi-byte payload must be accepted');
          const body = JSON.parse(responseData);
          assert.equal(body.ok, true);
          cleanup();
        } catch (err) {
          cleanup(err);
        }
      });
    });

    req.on('error', (err) => {
      cleanup(err);
    });

    req.write(chunk1);
    req.write(chunk2);
    req.end();
  }, done);
});
test('static file added after startup is served, traversal still 404 (EGC#918)', (t, done) => {
  runWithDashboardServer((port, cleanup) => {
    const PUBLIC = path.join(__dirname, '..', 'dashboard', 'public');
    const fileName = `late-added-${Date.now()}-${process.pid}.txt`;
    const filePath = path.join(PUBLIC, fileName);
    const relPath = '/' + fileName;
    fs.writeFileSync(filePath, 'hello-after-startup', 'utf8');

    const get = (p) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      req.end();
    });

    const finish = (err) => {
      try { fs.unlinkSync(filePath); } catch (_) { /* best-effort cleanup */ }
      cleanup(err);
    };

    (async () => {
      try {
        const late = await get(relPath);
        assert.equal(late.status, 200, 'Late-added static file must be served without restart');
        assert.equal(late.data, 'hello-after-startup', 'Served file content must match');

        const traversal = await get('/../server.js');
        assert.equal(traversal.status, 404, 'Traversal path must still 404');

        const encoded = await get('/%2e%2e/server.js');
        assert.equal(encoded.status, 404, 'Encoded traversal must still 404');

        finish();
      } catch (err) {
        finish(err);
      }
    })();
  }, done);
});

test('debounce: burst of misses triggers at most one rebuild per interval (EGC#918)', (t, done) => {
  runWithDashboardServer((port, cleanup) => {
    const PUBLIC = path.join(__dirname, '..', 'dashboard', 'public');
    const fileName = `debounce-test-${Date.now()}-${process.pid}.txt`;
    const filePath = path.join(PUBLIC, fileName);
    const relPath = '/' + fileName;

    const get = (p) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      req.end();
    });

    const finish = (err) => {
      try { fs.unlinkSync(filePath); } catch (_) { /* best-effort cleanup */ }
      cleanup(err);
    };

    (async () => {
      try {
        // Miss 1 — triggers rebuild (before file exists → 404)
        const miss1 = await get(relPath);
        assert.equal(miss1.status, 404, 'Miss before file created should 404');

        // Create the file
        fs.writeFileSync(filePath, 'debounced', 'utf8');

        // Miss 2 — inside debounce window, should NOT rebuild → 404
        const miss2 = await get(relPath);
        assert.equal(miss2.status, 404, 'Second miss inside debounce window should still 404');

        // Wait for debounce window to pass
        await new Promise(r => setTimeout(r, 3500));

        // Miss 3 — after window, should rebuild and serve
        const miss3 = await get(relPath);
        assert.equal(miss3.status, 200, 'Miss after debounce window should serve the file');
        assert.equal(miss3.data, 'debounced', 'Served content must match');

        finish();
      } catch (err) {
        finish(err);
      }
    })();
  }, done);
});

// ---------------------------------------------------------------------------
// POST /event authentication, ide allowlist, CORS pin, WebSocket origin
// (security audit 2026-08-17, F1/F4/F9/F10)
// ---------------------------------------------------------------------------

function requestDashboard(port, { body, headers = {}, method = 'POST', path: reqPath = '/event' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : body;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: { 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function withDashboardServer(fn) {
  return new Promise((resolve, reject) => {
    runWithDashboardServer((port, cleanup) => {
      fn(port).then(() => cleanup(), err => cleanup(err));
    }, err => (err ? reject(err) : resolve()));
  });
}

function eventHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', [TOKEN_HEADER]: dashboardToken(), ...extra };
}

const EVENT = JSON.stringify({ ide: 'claude', event: 'pre_tool', tool: 'Bash', detail: 'git status' });

test('POST /event without the dashboard token is refused with 401', () => withDashboardServer(async port => {
  const res = await requestDashboard(port, { body: EVENT, headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 401);
  assert.match(JSON.parse(res.body).error, /token/i);
}));

test('POST /event with a wrong token is refused with 401', () => withDashboardServer(async port => {
  const res = await requestDashboard(port, { body: EVENT, headers: eventHeaders({ [TOKEN_HEADER]: 'f'.repeat(64) }) });
  assert.equal(res.status, 401);
}));

test('POST /event with a non-JSON Content-Type is refused with 415', () => withDashboardServer(async port => {
  const res = await requestDashboard(port, { body: EVENT, headers: eventHeaders({ 'Content-Type': 'text/plain' }) });
  assert.equal(res.status, 415);
}));

test('POST /event carrying a browser Origin other than the panel is refused with 403', () => withDashboardServer(async port => {
  const res = await requestDashboard(port, { body: EVENT, headers: eventHeaders({ Origin: 'http://localhost:9999' }) });
  assert.equal(res.status, 403);
}));

test('POST /event with the token, JSON and the panel origin (or none) is accepted', () => withDashboardServer(async port => {
  const plain = await requestDashboard(port, { body: EVENT, headers: eventHeaders() });
  assert.equal(plain.status, 200);
  assert.equal(JSON.parse(plain.body).ok, true);
  const panel = await requestDashboard(port, { body: EVENT, headers: eventHeaders({ Origin: `http://localhost:${PANEL_PORT}` }) });
  assert.equal(panel.status, 200);
}));

test('POST /event refuses an ide the dashboard does not know, including markup', () => withDashboardServer(async port => {
  for (const ide of ['<img src=x onerror=alert(1)>', 'not-a-real-tool', 'CLAUDE', '']) {
    const res = await requestDashboard(port, { body: JSON.stringify({ ide, event: 'pre_tool' }), headers: eventHeaders() });
    assert.equal(res.status, 400, `ide ${JSON.stringify(ide)} must be refused`);
    assert.equal(JSON.parse(res.body).error, 'Unknown ide');
  }
}));

test('CORS is pinned to the panel origin instead of reflecting any localhost origin', () => withDashboardServer(async port => {
  const foreign = await requestDashboard(port, { method: 'GET', path: '/ping', headers: { Origin: 'http://localhost:9999' } });
  assert.equal(foreign.headers['access-control-allow-origin'], `http://localhost:${PANEL_PORT}`);
  const panel = await requestDashboard(port, { method: 'GET', path: '/ping', headers: { Origin: `http://127.0.0.1:${PANEL_PORT}` } });
  assert.equal(panel.headers['access-control-allow-origin'], `http://127.0.0.1:${PANEL_PORT}`);
}));

function connectWebSocket(port, origin) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    ws.on('open', () => { ws.close(); resolve({ opened: true }); });
    ws.on('unexpected-response', (req, res) => { req.destroy(); resolve({ opened: false, status: res.statusCode }); });
    ws.on('error', error => resolve({ opened: false, error: error.message }));
  });
}

test('WebSocket upgrade is refused without the panel origin and accepted with it', () => withDashboardServer(async port => {
  const foreign = await connectWebSocket(port, 'http://localhost:9999');
  assert.equal(foreign.opened, false, 'a foreign origin must not join the broadcast');
  assert.equal(foreign.status, 401);
  const none = await connectWebSocket(port, undefined);
  assert.equal(none.opened, false, 'an upgrade without an origin must not join either');
  const panel = await connectWebSocket(port, `http://localhost:${PANEL_PORT}`);
  assert.equal(panel.opened, true, 'the panel itself must connect');
}));
