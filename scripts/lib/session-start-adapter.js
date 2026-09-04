'use strict';

// Shared process adapter for SessionStart-style hooks. It owns the generic
// stdin, state-loader, and Dashboard contracts while leaving each host wrapper
// responsible for its own output or session-injection mechanism.

const fs = require('node:fs');
const http = require('node:http');
// The token reader ships with the hooks runtime; an install recorded before
// it existed has no copy until egc repair refreshes it, and then the event
// goes out without a token instead of the hook failing to load.
let readDashboardToken = () => null;
try {
  const loaded = require('./dashboard-token');
  if (typeof loaded.readDashboardToken === 'function') readDashboardToken = loaded.readDashboardToken;
} catch {
  // an older install without the helper: no token, no crash
}

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
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  const token = readDashboardToken();
  if (token) headers['x-egc-token'] = token;
  const request = http.request(
    {
      hostname: '127.0.0.1',
      port: resolveDashboardPort(),
      path: '/event',
      method: 'POST',
      headers,
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
    // Bridge the payload session id to Crusher children (see session-marker.js):
    // a hook cannot export env vars into the harness's future Bash commands.
    const marker = requireSessionMarker();
    if (marker) {
      try {
        marker.writeMarker(input.session_id, { source: normalizedHost });
      } catch { // NOSONAR: the marker is best-effort; session start must never break
        // keep going: restoring context matters more than attribution
      }
    }
  }
  return restored;
}

// Repo layout keeps the lib at ./crusher/session-marker; the flattened egc/lib
// install (claude-home HOOK_LIB_SOURCES) lands it beside this file instead.
function requireSessionMarker() {
  try {
    return require('./crusher/session-marker');
  } catch { // NOSONAR: flattened install layout, fall through
    try {
      return require('./session-marker');
    } catch { // NOSONAR: no marker lib shipped means no attribution bridge
      return null;
    }
  }
}

module.exports = { runSessionStartAdapter };
