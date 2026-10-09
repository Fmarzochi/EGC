'use strict';

/**
 * scripts/lib/operations/session-bus.js
 *
 * Session bus operations (slice 3, #1238): sessionPeers, sessionSend and
 * sessionEvents, reached through the egc-memory MCP server.
 */

const { normalizeParams } = require('./params');
const { _callBusTool } = require('./mcp-bridge');
const { _parseEventsText, _parsePeersText, _parseSendText } = require('./bus-parsers');

/**
 * List live sessions and active path locks on the session bus.
 *
 * @param {object} [params]
 * @param {string} [params.projectPath] - Filter to one project path
 * @returns {{ peers: object[], locks: object[] }}
 */
async function sessionPeers(params) {
  const p = normalizeParams(params);
  if (p.projectPath !== undefined && (typeof p.projectPath !== 'string' || !p.projectPath.trim())) {
    throw Object.assign(new Error('"projectPath" must be a non-empty string'), { statusCode: 400 });
  }
  const args = {};
  if (p.projectPath) args.project_path = p.projectPath;
  const raw = await _callBusTool('session_peers', args);
  // The MCP tool returns human-readable text; parse it into structured objects.
  if (typeof raw === 'string') return _parsePeersText(raw);
  // Fallback: if a future server version returns JSON, handle that too.
  if (Array.isArray(raw)) return { peers: raw, locks: [] };
  // Guard against null / non-object to avoid TypeError on property access.
  if (raw && typeof raw === 'object') return { peers: raw.peers || [], locks: raw.locks || [] };
  return { peers: [], locks: [] };
}

/**
 * Send an event to another live session or broadcast to the project.
 *
 * @param {object} params
 * @param {string} [params.sessionId]   - Sender session id
 * @param {string} [params.toSession]   - Target session id; omit to broadcast
 * @param {string} [params.projectPath] - Project scope for broadcast delivery
 * @param {string} params.kind          - Short event type, e.g. 'handoff'
 * @param {string} [params.payload]     - Event body (max 16 KB)
 * @returns {{ ok: boolean, eventId?: number, reason?: string }}
 */
/**
 * Validate params for sessionSend.  Throws with statusCode:400 on bad input.
 * Extracted to keep sessionSend under the ESLint complexity limit.
 */
function _validateSendParams(p) {
  if (!p.kind || typeof p.kind !== 'string' || !p.kind.trim()) {
    throw Object.assign(
      new Error('"kind" is required and must be a non-empty string'),
      { statusCode: 400 }
    );
  }
  if (p.toSession   !== undefined && typeof p.toSession   !== 'string') throw Object.assign(new Error('"toSession" must be a string'),   { statusCode: 400 });
  if (p.sessionId   !== undefined && typeof p.sessionId   !== 'string') throw Object.assign(new Error('"sessionId" must be a string'),   { statusCode: 400 });
  if (p.projectPath !== undefined && typeof p.projectPath !== 'string') throw Object.assign(new Error('"projectPath" must be a string'), { statusCode: 400 });
  if (p.payload     !== undefined && typeof p.payload     !== 'string') throw Object.assign(new Error('"payload" must be a string'),     { statusCode: 400 });
  // Enforce the 16 KB payload limit (MCP server also enforces it, but a 400 here is cleaner than a 500).
  if (p.payload && Buffer.byteLength(p.payload, 'utf8') > 16 * 1024) {
    throw Object.assign(new Error('"payload" exceeds the 16 KB limit'), { statusCode: 400 });
  }
}

async function sessionSend(params) {
  const p = normalizeParams(params);
  _validateSendParams(p);

  const args = { kind: p.kind.trim() };
  if (p.sessionId)   args.session_id   = p.sessionId;
  if (p.toSession)   args.to_session   = p.toSession;
  if (p.projectPath) args.project_path = p.projectPath;
  if (p.payload)     args.payload      = p.payload;
  const raw = await _callBusTool('session_send', args);
  if (typeof raw === 'string') return _parseSendText(raw);
  // Fallback for JSON-returning server versions; guard against null/non-object.
  if (raw && typeof raw === 'object') return raw;
  return { ok: false, reason: 'unexpected response from session bus' };
}

/**
 * Read events addressed to a session (direct and broadcast), oldest first.
 * Each event is delivered exactly once unless peek: true.
 *
 * @param {object} [params]
 * @param {string} [params.sessionId]   - Reader session id
 * @param {string} [params.projectPath] - Include broadcasts for this project
 * @param {boolean} [params.peek]       - Read without advancing the cursor
 * @returns {object[]} array of event records
 */
async function sessionEvents(params) {
  const p = normalizeParams(params);
  if (p.sessionId !== undefined && typeof p.sessionId !== 'string') {
    throw Object.assign(new Error('"sessionId" must be a string'), { statusCode: 400 });
  }
  if (p.projectPath !== undefined && (typeof p.projectPath !== 'string' || !p.projectPath.trim())) {
    throw Object.assign(new Error('"projectPath" must be a non-empty string'), { statusCode: 400 });
  }
  if (p.peek !== undefined && typeof p.peek !== 'boolean') {
    throw Object.assign(new Error('"peek" must be a boolean'), { statusCode: 400 });
  }
  const args = {};
  if (p.sessionId)   args.session_id   = p.sessionId;
  if (p.projectPath) args.project_path = p.projectPath;
  if (p.peek !== undefined) args.peek  = Boolean(p.peek);
  const raw = await _callBusTool('session_events', args);
  if (typeof raw === 'string') return _parseEventsText(raw);
  // Fallback for JSON-returning server versions
  // Guard against null / non-object to avoid TypeError on property access.
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return raw.events || [];
  return [];
}

module.exports = { sessionEvents, sessionPeers, sessionSend };
