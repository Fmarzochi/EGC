'use strict';

// Local, zero-cost savings ledger for the Token Crusher. Records are JSONL in
// ~/.egc/metrics/crusher.jsonl so reading or reporting them never touches a
// model context. The unified metrics.db aggregation across all compression
// layers builds on top of this file later without a schema migration.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const UNKNOWN_SCOPE = 'unknown';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Return the machine-local Crusher ledger path. */
function metricsFilePath() {
  return process.env.EGC_CRUSHER_METRICS_FILE || process.env.EGC_METRICS_FILE || path.join(os.homedir(), '.egc', 'metrics', 'crusher.jsonl');
}

/** Normalize a session-like scope label while preserving legacy unknowns. */
function normalizeScope(value) {
  if (typeof value !== 'string') return UNKNOWN_SCOPE;
  const normalized = value.trim();
  return normalized && normalized !== UNKNOWN_SCOPE ? normalized : UNKNOWN_SCOPE;
}

/** Normalize a project path into a stable absolute machine-local identifier. */
function normalizeProject(value) {
  const normalized = normalizeScope(value);
  if (normalized === UNKNOWN_SCOPE) return UNKNOWN_SCOPE;
  try {
    return path.resolve(normalized);
  } catch {
    return normalized;
  }
}

/** Attach backward-compatible project/session buckets to one ledger entry. */
function normalizeEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  return {
    ...source,
    project: normalizeProject(source.project),
    session: normalizeScope(source.session),
  };
}

/** Resolve the attribution available to a Crusher child process. */
function resolveMetricContext({ cwd = process.cwd(), env = process.env } = {}) {
  const project = env.EGC_PROJECT_ROOT || env.EGC_PROJECT_DIR || env.PROJECT_ROOT || cwd;
  // The environment only carries a session id under a wrapper-launched host
  // (e.g. the Gemini CLI). Hooks cannot export variables into the harness's
  // Bash environment, so everywhere else the SessionStart-written marker file
  // is the bridge; env always wins when both exist.
  const session = env.EGC_SESSION_ID || env.ECC_SESSION_ID || readSessionMarker();
  return {
    project: normalizeProject(project),
    session: normalizeScope(session),
  };
}

function readSessionMarker() {
  try {
    return require('./session-marker').readMarkerSession();
  } catch { // NOSONAR: attribution is best-effort; a missing marker lib means no fallback
    return null;
  }
}

/** Append one best-effort ledger row without ever breaking the wrapped command. */
function record(entry) {
  try {
    const file = metricsFilePath();
    const context = resolveMetricContext();
    const row = normalizeEntry({
      ts: new Date().toISOString(),
      ...entry,
      project: entry?.project ?? context.project,
      session: entry?.session ?? context.session,
    });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
  } catch { // NOSONAR: accounting must never break the command being run
    // ignore: savings accounting is best-effort
  }
}

/** Read every valid JSONL row and normalize legacy scope fields. */
function readAll(filePath) {
  try {
    const file = filePath || metricsFilePath();
    const raw = fs.readFileSync(file, 'utf8');
    return raw.split('\n').filter(Boolean).map(line => {
      try {
        return normalizeEntry(JSON.parse(line));
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Aggregate totals and command-kind savings for a set of ledger rows. */
function aggregate(entries) {
  const totals = { runs: 0, bytesIn: 0, bytesOut: 0, tokensSaved: 0, byKind: {} };
  for (const rawEntry of entries) {
    const entry = normalizeEntry(rawEntry);
    totals.runs += 1;
    totals.bytesIn += finiteNumber(entry.bytesIn);
    totals.bytesOut += finiteNumber(entry.bytesOut);
    totals.tokensSaved += finiteNumber(entry.tokensSaved);
    const kind = typeof entry.kind === 'string' && entry.kind ? entry.kind : 'generic';
    totals.byKind[kind] = totals.byKind[kind] || { runs: 0, tokensSaved: 0 };
    totals.byKind[kind].runs += 1;
    totals.byKind[kind].tokensSaved += finiteNumber(entry.tokensSaved);
  }
  return totals;
}

function timestampMs(entry) {
  const value = Date.parse(entry?.ts);
  return Number.isFinite(value) ? value : null;
}

function aggregateWindow(timestampedEntries, startMs, endMs) {
  return aggregate(timestampedEntries
    .filter(({ timestamp }) => timestamp >= startMs && timestamp <= endMs)
    .map(({ entry }) => entry));
}

/**
 * Build the time-, project-, and session-scoped statistics used by `egc gain`.
 * Today follows the user's local calendar day; 7d/30d are exact rolling spans.
 */
function aggregateBreakdown(entries, options = {}) {
  const parsedNow = options.now instanceof Date
    ? new Date(options.now)
    : new Date(options.now ?? Date.now());
  const now = Number.isFinite(parsedNow.getTime()) ? parsedNow : new Date();
  const context = resolveMetricContext(options.context || {});
  const project = normalizeProject(options.project ?? context.project);
  const session = normalizeScope(options.session ?? context.session);
  const normalizedEntries = entries.map(normalizeEntry);
  const timestampedEntries = normalizedEntries
    .map(entry => ({ entry, timestamp: timestampMs(entry) }))
    .filter(item => item.timestamp !== null);
  const nowMs = now.getTime();
  const localDayStart = new Date(now);
  localDayStart.setHours(0, 0, 0, 0);

  const sinceInstall = aggregate(normalizedEntries);
  const projectEntries = project === UNKNOWN_SCOPE
    ? []
    : normalizedEntries.filter(entry => entry.project === project);
  const sessionEntries = session === UNKNOWN_SCOPE
    ? []
    : normalizedEntries.filter(entry => entry.session === session);
  const biggestEntry = normalizedEntries.reduce((biggest, entry) => (
    biggest === null || finiteNumber(entry.tokensSaved) > finiteNumber(biggest.tokensSaved) ? entry : biggest
  ), null);
  const firstTimestamp = timestampedEntries.reduce((earliest, item) => (
    earliest === null || item.timestamp < earliest ? item.timestamp : earliest
  ), null);

  return {
    generatedAt: now.toISOString(),
    scopes: { project, session },
    today: aggregateWindow(timestampedEntries, localDayStart.getTime(), nowMs),
    currentSession: {
      available: session !== UNKNOWN_SCOPE,
      ...aggregate(sessionEntries),
    },
    currentProject: {
      available: project !== UNKNOWN_SCOPE,
      ...aggregate(projectEntries),
    },
    sinceInstall: {
      startedAt: firstTimestamp === null ? null : new Date(firstTimestamp).toISOString(),
      ...sinceInstall,
    },
    last7Days: aggregateWindow(timestampedEntries, nowMs - (7 * DAY_MS), nowMs),
    last30Days: aggregateWindow(timestampedEntries, nowMs - (30 * DAY_MS), nowMs),
    runs: sinceInstall.runs,
    averagePerRun: sinceInstall.runs > 0
      ? Math.round(sinceInstall.tokensSaved / sinceInstall.runs)
      : 0,
    biggest: biggestEntry ? {
      ts: biggestEntry.ts || null,
      cmd: biggestEntry.cmd || '',
      kind: biggestEntry.kind || 'generic',
      tokensSaved: finiteNumber(biggestEntry.tokensSaved),
      project: biggestEntry.project,
      session: biggestEntry.session,
    } : null,
  };
}

module.exports = {
  UNKNOWN_SCOPE,
  metricsFilePath,
  normalizeEntry,
  resolveMetricContext,
  record,
  readAll,
  aggregate,
  aggregateBreakdown,
};
