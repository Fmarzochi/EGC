'use strict';

// Local, zero-cost savings ledger for the Token Crusher. Records are JSONL in
// ~/.egc/metrics/crusher.jsonl so reading or reporting them never touches a
// model context. The unified metrics.db aggregation across all compression
// layers builds on top of this file later without a schema migration.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function metricsFilePath() {
  return path.join(os.homedir(), '.egc', 'metrics', 'crusher.jsonl');
}

function record(entry) {
  try {
    const file = metricsFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { // NOSONAR: accounting must never break the command being run
    // ignore: savings accounting is best-effort
  }
}

function readAll() {
  try {
    const raw = fs.readFileSync(metricsFilePath(), 'utf8');
    return raw.split('\n').filter(Boolean).map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function aggregate(entries) {
  const totals = { runs: 0, bytesIn: 0, bytesOut: 0, tokensSaved: 0, byKind: {} };
  for (const e of entries) {
    totals.runs += 1;
    totals.bytesIn += e.bytesIn || 0;
    totals.bytesOut += e.bytesOut || 0;
    totals.tokensSaved += e.tokensSaved || 0;
    const kind = e.kind || 'generic';
    totals.byKind[kind] = totals.byKind[kind] || { runs: 0, tokensSaved: 0 };
    totals.byKind[kind].runs += 1;
    totals.byKind[kind].tokensSaved += e.tokensSaved || 0;
  }
  return totals;
}

module.exports = { metricsFilePath, record, readAll, aggregate };
