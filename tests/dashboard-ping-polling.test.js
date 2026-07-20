'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashboardPath = path.join(
  __dirname,
  '..',
  'dashboard',
  'public',
  'index.html'
);

const dashboardSource = fs.readFileSync(dashboardPath, 'utf8');

function extractFunctionBody(source, functionName) {
  const marker = `function ${functionName}(`;
  const functionStart = source.indexOf(marker);

  assert.notEqual(
    functionStart,
    -1,
    `${functionName} should exist in dashboard/public/index.html`
  );

  const bodyStart = source.indexOf('{', functionStart);
  let depth = 0;

  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') {
      depth++;
    } else if (source[index] === '}') {
      depth--;

      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  throw new Error(`Could not extract ${functionName} body`);
}

test('ping polling continues with one timer while WebSocket is down', async () => {
  const functionBody = extractFunctionBody(
    dashboardSource,
    'pingLatency'
  );

  const S = {
    ws: null,
    pingReqId: 0,
    pingTimerId: 41
  };

  const activeTimers = new Set([41]);
  const clearedTimers = [];
  const scheduledDelays = [];
  const requestedUrls = [];
  const pollResults = [];

  let nextTimerId = 100;

  function clearTimeoutStub(timerId) {
    clearedTimers.push(timerId);
    activeTimers.delete(timerId);
  }

  function setTimeoutStub(_callback, delay) {
    const timerId = nextTimerId++;
    scheduledDelays.push(delay);
    activeTimers.add(timerId);
    return timerId;
  }

  async function fetchStub(url) {
    requestedUrls.push(url);
    throw new Error('server unavailable');
  }

  function reportPollResultStub(name, result) {
    pollResults.push([name, result]);
  }

  const documentStub = {
    getElementById() {
      return { textContent: '' };
    }
  };

  const createPingLatency = new Function(
    'S',
    'fetch',
    'clearTimeout',
    'setTimeout',
    'reportPollResult',
    'document',
    `return function pingLatency() {
      ${functionBody}
    };`
  );

  const pingLatency = createPingLatency(
    S,
    fetchStub,
    clearTimeoutStub,
    setTimeoutStub,
    reportPollResultStub,
    documentStub
  );

  pingLatency();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(requestedUrls, ['/ping']);
  assert.deepEqual(pollResults, [['ping', false]]);
  assert.deepEqual(clearedTimers, [41]);
  assert.deepEqual(scheduledDelays, [5000]);
  assert.equal(activeTimers.size, 1);
  assert.ok(activeTimers.has(100));
  assert.equal(S.pingTimerId, 100);

  pingLatency();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(requestedUrls, ['/ping', '/ping']);
  assert.deepEqual(pollResults, [
    ['ping', false],
    ['ping', false]
  ]);
  assert.deepEqual(clearedTimers, [41, 100]);
  assert.deepEqual(scheduledDelays, [5000, 5000]);
  assert.equal(activeTimers.size, 1);
  assert.ok(activeTimers.has(101));
  assert.equal(S.pingTimerId, 101);
});

test('ping polling starts independently during dashboard initialization', () => {
  const connectBody = extractFunctionBody(dashboardSource, 'connect');

  assert.doesNotMatch(
    connectBody,
    /\bpingLatency\(\)/,
    'WebSocket onopen should not be responsible for starting ping polling'
  );

  assert.match(
    dashboardSource,
    /\nconnect\(\);\s*\npingLatency\(\);/,
    'dashboard initialization should start ping polling independently'
  );
});