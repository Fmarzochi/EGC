'use strict';

// Session marker: bridges the harness session id into Crusher child processes.
//
// Hooks receive `session_id` in their JSON payload, but a hook process cannot
// export environment variables into the harness's future Bash commands, and
// the PreToolUse rewrite is ignored for assistant-issued calls (the same
// confirmed limitation rules/common/memory.md documents). The result was a
// ledger where `egc gain` could never resolve "Current session" outside a
// wrapper-launched host like the Gemini CLI.
//
// The bridge: the SessionStart adapter writes this marker file, and
// resolveMetricContext() in metrics.js falls back to it whenever
// EGC_SESSION_ID is absent from the environment. A freshness window bounds
// the fallback so a marker left behind by a closed session cannot claim
// entries forever, and each new SessionStart overwrites the file, so with
// concurrent sessions the most recently started one wins (recording the
// limitation is deliberate: the payload is the only trustworthy source, and
// no clear-on-stop exists because the Stop hook fires per assistant turn,
// not per session).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function markerFilePath() {
  return process.env.EGC_SESSION_MARKER_FILE
    || path.join(os.homedir(), '.egc', 'metrics', 'active-session.json');
}

/** Persist the harness session id for later Crusher child processes. */
function writeMarker(sessionId, { source } = {}) {
  try {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return false;
    const file = markerFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const row = {
      session: sessionId,
      source: typeof source === 'string' && source ? source : 'unknown',
      startedAt: new Date().toISOString(),
    };
    // Atomic replace: a Crusher child reading mid-write must never see a
    // truncated JSON body.
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(row) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch { // NOSONAR: the marker is best-effort; session start must never break
    return false;
  }
}

/** Return the fresh marker session id, or null when absent, stale or invalid. */
function readMarkerSession({ maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  try {
    const raw = fs.readFileSync(markerFilePath(), 'utf8');
    const row = JSON.parse(raw);
    if (typeof row?.session !== 'string' || !SESSION_ID_RE.test(row.session)) return null;
    const startedAt = Date.parse(row.startedAt);
    if (!Number.isFinite(startedAt)) return null;
    const age = now - startedAt;
    if (age < 0 || age > maxAgeMs) return null;
    return row.session;
  } catch { // NOSONAR: no marker (or an unreadable one) simply means no fallback
    return null;
  }
}

module.exports = {
  markerFilePath,
  writeMarker,
  readMarkerSession,
};
