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
// Hard cap measured from startedAt: readers touch the file to keep a live
// session's attribution alive past the idle window, but any reader can touch
// (record() from strays, a plain egc gain), so without this cap a dead
// session's marker could be kept alive indefinitely by machine-wide activity.
const DEFAULT_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
// Filesystem mtime granularity can land a fresh write fractionally ahead of
// Date.now(); a marker is only "from the future" past this slack.
const FUTURE_SKEW_MS = 60 * 1000;

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

/**
 * Return the fresh marker session id, or null when absent, stale or invalid.
 *
 * Two clocks bound the fallback. The idle window reads from the file's
 * mtime: every successful read touches the file, so a session that keeps
 * recording ledger entries keeps its own marker fresh past the window, while
 * a marker nobody uses ages out. The lifetime cap reads from startedAt: any
 * reader can touch the file (strays, a plain egc gain), so idle refresh alone
 * would let machine-wide activity keep a dead session's marker alive forever;
 * past the cap the marker expires no matter how recently it was touched. A
 * stale or invalid marker is never touched.
 */
function readMarkerSession({ maxAgeMs = DEFAULT_MAX_AGE_MS, maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS, now = Date.now() } = {}) {
  try {
    const file = markerFilePath();
    const mtimeMs = fs.statSync(file).mtimeMs;
    const age = now - mtimeMs;
    if (age < -FUTURE_SKEW_MS || age > maxAgeMs) return null;
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof row?.session !== 'string' || !SESSION_ID_RE.test(row.session)) return null;
    const startedAt = Date.parse(row.startedAt);
    if (!Number.isFinite(startedAt) || now - startedAt > maxLifetimeMs) return null;
    try {
      fs.utimesSync(file, new Date(now), new Date(now));
    } catch { // NOSONAR: refreshing is best-effort; a read-only marker still resolves
      // stale-out will eventually apply; resolution still works this call
    }
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
