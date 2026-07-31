#!/usr/bin/env node
'use strict';

// Thin Node bridge for OpenCode's in-process plugin. It isolates the shared
// loader behind a fail-open child process, serializes the restored context as
// data, and reports OpenCode telemetry. The plugin remains responsible for
// injecting the returned context into the live session.

const fs = require('node:fs');
const http = require('node:http');

const HOST = 'opencode';
const rawPort = process.env.EGC_PORT;
const parsedPort = rawPort && /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
const DASHBOARD_PORT = !Number.isNaN(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
  ? parsedPort
  : 7890;

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_error) { // NOSONAR
    // Invalid input is handled as an empty event.
  }
  return {};
}

function resolveProjectPath(input) {
  if (typeof input.cwd === 'string' && input.cwd.length > 0) {
    return input.cwd;
  }
  return process.env.OPENCODE_PROJECT_DIR || process.env.PWD || process.cwd();
}

function restoreContext(projectPath) {
  try {
    const { loadSessionContext } = require('../lib/session-context-loader');
    return loadSessionContext({ projectPath, host: HOST });
  } catch (_) { // NOSONAR: missing or broken loader must stay fail-open
    return { host: HOST, context: '' };
  }
}

function postSessionStart(host, sessionId) {
  const body = JSON.stringify({ ide: host, event: 'session_start', session_id: sessionId });
  const request = http.request(
    {
      hostname: '127.0.0.1',
      port: DASHBOARD_PORT,
      path: '/event',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 200,
    },
    response => response.resume()
  );
  request.on('error', () => {});
  request.on('timeout', () => request.destroy());
  request.end(body);
}

function main() {
  const input = readStdinJson();
  const restored = restoreContext(resolveProjectPath(input));
  process.stdout.write(JSON.stringify(restored));
  postSessionStart(restored.host || HOST, input.session_id || null);
}

main();
