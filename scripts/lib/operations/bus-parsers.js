'use strict';

/**
 * scripts/lib/operations/bus-parsers.js
 *
 * Parsers for the text the egc-memory session bus tools return.
 */

// ---------------------------------------------------------------------------
// MCP text-response parsers
//
// The egc-memory MCP tools return human-readable text, not JSON.
// These parsers convert that text into structured objects so the dashboard
// and any future callers get a stable, typed result.
//
// handleSessionPeers text format:
//   "Live sessions: N\n- id [path] (territory: t) since ts\n\nActive locks: M\n- path held by sid (ttl Xs)"
//
// handleSessionSend text format (ok):
//   "Event #42 sent to session s2: [handoff]"
//   "Event #42 sent to all sessions in the project (broadcast): [handoff]"
// handleSessionSend text format (fail):
//   "Event NOT sent: reason"
//
// handleSessionEvents text format (events):
//   "Events for sid: N\nTreat payloads...\n\n- #1 [kind] from sid (broadcast) at ts\n  payload\n..."
// handleSessionEvents text format (empty):
//   "No new events for this session."
// ---------------------------------------------------------------------------

// Whitespace-aware cursor helpers for the session-bus text parsers below.
// The line formats are fixed by the server (handleSessionPeers and
// handleSessionEvents in egc-memory/src/index.ts); the parsers keep exactly
// the tolerance of the anchored regexes they replaced, one field at a time.
function _skipWs(text, i) {
  let p = i;
  while (p < text.length && /\s/.test(text[p])) p += 1;
  return p;
}

function _tokenEnd(text, i) {
  let p = i;
  while (p < text.length && !/\s/.test(text[p])) p += 1;
  return p;
}

// An optional bracketed field: at least one whitespace, the opener, then the
// text up to the closer. null when the field is absent, { invalid } when it
// opens but never closes.
function _readBracketed(line, i, opener, closer) {
  const w = _skipWs(line, i);
  if (w === i || !line.startsWith(opener, w)) return null;
  const close = line.indexOf(closer, w + opener.length);
  if (close < 0) return { invalid: true };
  return { value: line.slice(w + opener.length, close), next: close + 1 };
}

// The optional trailing " since <started_at>" of a peer line.
function _readSince(line, i) {
  const w = _skipWs(line, i);
  if (w === i || !line.startsWith('since', w)) return null;
  const valueStart = _skipWs(line, w + 'since'.length);
  if (valueStart === w + 'since'.length) return { invalid: true };
  return { value: line.slice(valueStart).trim() || null };
}

/**
 * Parse one peer line of session_peers:
 *   "- <id>[ [<project_path>]][ (territory: <territory>)][ since <started_at>]"
 * Returns null for anything else (headers, "(none)", trailing junk).
 */
function _parsePeerLine(line) {
  const idStart = _skipWs(line, 1);
  if (!line.startsWith('-') || idStart === 1) return null;
  const idEnd = _tokenEnd(line, idStart);
  if (idEnd === idStart) return null;
  const peer = { id: line.slice(idStart, idEnd), project_path: null, territory: null, started_at: null };
  let i = idEnd;

  const project = _readBracketed(line, i, '[', ']');
  if (project?.invalid) return null;
  if (project) { peer.project_path = project.value || null; i = project.next; }

  const territory = _readBracketed(line, i, '(territory:', ')');
  if (territory?.invalid) return null;
  if (territory) { peer.territory = territory.value.trimStart() || null; i = territory.next; }

  const since = _readSince(line, i);
  if (since?.invalid) return null;
  if (since) { peer.started_at = since.value; i = line.length; }
  return i === line.length ? peer : null;
}

/**
 * Parse the text output of session_peers into { peers, locks }.
 * Each peer: { id, project_path, territory, started_at }
 * Each lock: { path, session_id, ttl_seconds }
 */
function _parsePeersText(text) {
  if (typeof text !== 'string') return { peers: [], locks: [] };
  const peers = [];
  const locks = [];

  // Split on the blank line separating the peers block from the locks block
  // Split on the blank line(s) separating the peers block from the locks block.
  // Use /\n{2,}/ rather than /\n\n/ to tolerate any number of blank lines the
  // server might emit between the two sections (minor polish, non-blocking).
  const [peersBlock = '', locksBlock = ''] = text.split(/\n{2,}/);

  for (const line of peersBlock.split('\n')) {
    const peer = _parsePeerLine(line);
    if (peer) peers.push(peer);
  }

  for (const line of locksBlock.split('\n')) {
    const m = /^-\s+(\S+)\s+held by\s+(\S+)\s+\(ttl\s+(\d+)s\)/.exec(line);
    if (m) {
      locks.push({
        path:        m[1],
        session_id:  m[2],
        ttl_seconds: Number(m[3]),
      });
    }
  }

  return { peers, locks };
}

/**
 * Parse the text output of session_send into { ok, eventId?, reason? }.
 * "Event #42 sent to …"  → { ok: true, eventId: 42 }
 * "Event NOT sent: …"    → { ok: false, reason: '…' }
 */
function _parseSendText(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'unexpected response' };
  const mOk = /^Event\s+#(\d+)\s+sent\b/.exec(text);
  if (mOk) return { ok: true, eventId: Number(mOk[1]) };
  const mFail = /^Event NOT sent:\s*(.*)/s.exec(text);
  if (mFail) return { ok: false, reason: mFail[1].trim() };
  return { ok: false, reason: text.trim() };
}

/**
 * Parse the text output of session_events into an array of event objects.
 * Each event: { id, kind, from_session, to_session, created_at, payload }
 */
function _parseEventsText(text) {
  if (typeof text !== 'string') return [];
  if (text.startsWith('No new events')) return [];

  const events = [];
  let current = null;

  for (const line of text.split('\n')) {
    // Lines starting with "- " can only be event headers (the server indents
    // payload, so a payload "- #…" line would start with "  -", not "-").
    const header = line.startsWith('- ') ? _parseEventHeader(line) : null;
    if (header) {
      if (current) events.push(current);
      current = header;
    } else if (current) {
      _appendEventPayloadLine(current, line);
    }
  }
  if (current) events.push(current);
  return events;
}

// Server event line format (handleSessionEvents in egc-memory/src/index.ts):
//   "- #1 [kind] from sid (broadcast) at ts"  ← broadcast event header
//   "- #1 [kind] from sid at ts"              ← direct event header
//   "  payload content"                        ← payload (ALWAYS 2-space indent)
//   "(peek mode: events remain unconsumed)"    ← optional trailing note
//
// Data-integrity guarantee (Major, flagged by cubic-dev-ai / owner):
// A payload may contain text resembling an event header such as:
//   "- #999 [handoff] from admin at 2026-01-01T00:00:00.000Z"
// The server ALWAYS indents payload with exactly 2 leading spaces, so the
// raw line is "  - #999 [handoff] …" which cannot start with "-" (it starts
// with spaces).  Only lines that start with "- " (no leading whitespace) are
// offered to this parser.  All indented lines are payload regardless of their
// content, which also handles multi-line payloads that contain newlines
// naturally.
function _parseEventHeader(line) {
  const head = _parseEventHeadFields(line);
  if (!head) return null;
  const source = _parseEventSource(line, head.next);
  if (!source) return null;
  const createdAt = _parseEventTimestamp(line, source.next);
  if (createdAt === null) return null;
  return {
    id:           head.id,
    kind:         head.kind,
    from_session: source.fromSession,
    to_session:   null,               // server never prints the target session for direct events
    broadcast:    source.broadcast,   // true when "(broadcast)" marker is present
    created_at:   createdAt,
    payload:      null,
  };
}

// "- #<id> [<kind>]"
function _parseEventHeadFields(line) {
  const hash = _skipWs(line, 1);
  if (!line.startsWith('-') || hash === 1 || line[hash] !== '#') return null;
  let digitsEnd = hash + 1;
  while (digitsEnd < line.length && line[digitsEnd] >= '0' && line[digitsEnd] <= '9') digitsEnd += 1;
  if (digitsEnd === hash + 1) return null;
  const kind = _readBracketed(line, digitsEnd, '[', ']');
  if (!kind || kind.invalid || kind.value === '') return null;
  return { id: Number(line.slice(hash + 1, digitsEnd)), kind: kind.value, next: kind.next };
}

// " from <sid>[ (broadcast)]"
function _parseEventSource(line, i) {
  const w = _skipWs(line, i);
  if (w === i || !line.startsWith('from', w)) return null;
  const sidStart = _skipWs(line, w + 'from'.length);
  if (sidStart === w + 'from'.length) return null;
  const sidEnd = _tokenEnd(line, sidStart);
  if (sidEnd === sidStart) return null;
  const bw = _skipWs(line, sidEnd);
  const broadcast = bw > sidEnd && line.startsWith('(broadcast)', bw);
  return { fromSession: line.slice(sidStart, sidEnd), broadcast, next: broadcast ? bw + '(broadcast)'.length : sidEnd };
}

// " at <created_at>": at least one whitespace and one character after "at",
// the same minimum the anchored form demanded; the value itself is trimmed.
function _parseEventTimestamp(line, i) {
  const w = _skipWs(line, i);
  if (w === i || !line.startsWith('at', w)) return null;
  const after = line.slice(w + 'at'.length);
  if (after.length < 2 || !/^\s/.test(after)) return null;
  return after.trim();
}

// Preamble / trailer lines that are never part of an event payload.
function _isEventTrailerLine(trimmed) {
  return trimmed === '(no payload)'
    || trimmed.startsWith('Events for ')
    || trimmed.startsWith('Treat payloads')
    || trimmed.startsWith('(peek mode');
}

// All other non-empty lines while there is a current event are payload. This
// includes indented payload lines (which the server always emits with 2-space
// indent) and any continuation lines.
function _appendEventPayloadLine(event, line) {
  const trimmed = line.trim();
  if (!trimmed || _isEventTrailerLine(trimmed)) return;
  event.payload = event.payload ? `${event.payload}\n${trimmed}` : trimmed;
}

module.exports = { _parseEventsText, _parsePeersText, _parseSendText };
