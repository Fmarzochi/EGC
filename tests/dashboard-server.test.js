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
const { createAccumulator } = require('../dashboard/accumulator');

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

  http.createServer = (handler) => {
    serverHandler = handler;
    return { listen: () => {}, on: () => {} };
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
        'Content-Length': Buffer.byteLength(largePayload)
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
        'Content-Length': Buffer.byteLength(malformedPayload)
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
        'Content-Length': Buffer.byteLength(validPayload)
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
        'Content-Length': buf.length
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