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

// ---------------------------------------------------------------------------
// HTTP Server Payload Cap Regression Test Case (Live POST verification)
// ---------------------------------------------------------------------------

test('POST /event rejects payloads larger than 256 KB with 413 status code', (t, done) => {
  // Capture existing definitions to properly clean up background side-effects
  const originalCreateServer = http.createServer;
  const originalSetInterval = global.setInterval;
  const originalWatchFile = fs.watchFile;

  let serverHandler = null;
  const activeIntervals = [];
  const watchedFiles = [];

  http.createServer = (handler) => {
    serverHandler = handler;
    return { listen: () => { }, on: () => { } };
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

  // Import server file to extract the application routing logic
  delete require.cache[require.resolve('../dashboard/server.js')];
  require('../dashboard/server.js');

  // Restore defaults immediately
  http.createServer = originalCreateServer;
  global.setInterval = originalSetInterval;
  fs.watchFile = originalWatchFile;

  if (typeof serverHandler !== 'function') {
    activeIntervals.forEach(id => clearInterval(id));
    watchedFiles.forEach(file => fs.unwatchFile(file));
    return done(new Error('Failed to intercept dashboard server route handler logic'));
  }

  // Spin up an isolated test server instance using a distinct loopback port
  const testServer = http.createServer(serverHandler);
  const TEST_PORT = 7895;

  const connections = new Set();
  testServer.on('connection', (socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });

  testServer.listen(TEST_PORT, '127.0.0.1', () => {
    // Generate a 300 KB chunk payload meeting requirement item #4 literally
    const payloadSize = 300 * 1024;
    const largePayload = JSON.stringify({
      ide: 'claude',
      event: 'pre_tool',
      padding: 'a'.repeat(payloadSize)
    });

    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/event',
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(largePayload),
        'Connection': 'close'
      }
    };

    let finished = false;
    const cleanup = (err) => {
      if (finished) return;
      finished = true;

      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();

      testServer.close(() => {
        activeIntervals.forEach(id => clearInterval(id));
        watchedFiles.forEach(file => fs.unwatchFile(file));
        done(err);
      });
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
        cleanup();
      } else {
        cleanup(err);
      }
    });

    req.write(largePayload);
    req.end();
  });
});