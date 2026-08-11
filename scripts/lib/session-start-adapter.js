'use strict';

// Shared process adapter for SessionStart-style hooks. It owns the generic
// stdin, state-loader, and Dashboard contracts while leaving each host wrapper
// responsible for its own output or session-injection mechanism.

const fs = require('node:fs');
const http = require('node:http');

const DEFAULT_DASHBOARD_PORT = 7890;
const DASHBOARD_TIMEOUT_MS = 200;

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_error) { // NOSONAR: malformed or absent input intentionally falls back
    // Session restoration is best-effort; host environment values are enough.
  }
  return {};
}

function resolveProjectPath(input, projectEnv) {
  if (typeof input.cwd === 'string' && input.cwd.length > 0) {
    return input.cwd;
  }
  const environmentPath = typeof projectEnv === 'string' ? process.env[projectEnv] : '';
  return environmentPath || process.env.PWD || process.cwd();
}

function restoreContext(projectPath, host) {
  try {
    const { loadSessionContext } = require('./session-context-loader');
    return loadSessionContext({ projectPath, host });
  } catch (_) { // NOSONAR: a missing or broken loader must not block startup
    return { host, context: '' };
  }
}

function resolveDashboardPort() {
  const raw = process.env.EGC_PORT;
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_DASHBOARD_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? port
    : DEFAULT_DASHBOARD_PORT;
}

function postSessionStart(host, sessionId) {
  const body = JSON.stringify({ ide: host, event: 'session_start', session_id: sessionId });
  const request = http.request(
    {
      hostname: '127.0.0.1',
      port: resolveDashboardPort(),
      path: '/event',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: DASHBOARD_TIMEOUT_MS,
    },
    response => response.resume()
  );
  request.on('error', () => {});
  request.on('timeout', () => request.destroy());
  request.end(body);
}

function runSessionStartAdapter({ host, projectEnv }) {
  const normalizedHost = typeof host === 'string' && host ? host : 'unknown';
  const input = readStdinJson();
  const projectPath = resolveProjectPath(input, projectEnv);
  const restored = restoreContext(projectPath, normalizedHost);
  postSessionStart(restored.host || normalizedHost, input.session_id || null);
  if (input.session_id) {
    try {
      // Bridge the payload session id to Crusher children (see session-marker.js):
      // a hook cannot export env vars into the harness's future Bash commands.
      require('./crusher/session-marker').writeMarker(input.session_id, { source: normalizedHost });
    } catch { // NOSONAR: the marker is best-effort; session start must never break
      // keep going: restoring context matters more than attribution
    }
  }
  return restored;
}

module.exports = { runSessionStartAdapter };
