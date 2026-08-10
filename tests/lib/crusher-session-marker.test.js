'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  markerFilePath,
  writeMarker,
  readMarkerSession,
} = require('../../scripts/lib/crusher/session-marker');
const { resolveMetricContext } = require('../../scripts/lib/crusher/metrics');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function withMarkerFile(fn) {
  const dir = createTempDir('egc-session-marker-');
  const file = path.join(dir, 'active-session.json');
  const saved = process.env.EGC_SESSION_MARKER_FILE;
  process.env.EGC_SESSION_MARKER_FILE = file;
  try {
    return fn(file);
  } finally {
    if (saved === undefined) delete process.env.EGC_SESSION_MARKER_FILE;
    else process.env.EGC_SESSION_MARKER_FILE = saved;
    cleanup(dir);
  }
}

// ── markerFilePath ──────────────────────────────────────────────────────────

withMarkerFile(file => {
  assert.strictEqual(markerFilePath(), file, 'EGC_SESSION_MARKER_FILE must override the default path');
});

// ── write + read round trip ─────────────────────────────────────────────────

withMarkerFile(file => {
  assert.strictEqual(writeMarker('sess-abc_123.X', { source: 'claude' }), true);
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(row.session, 'sess-abc_123.X');
  assert.strictEqual(row.source, 'claude');
  assert.ok(Number.isFinite(Date.parse(row.startedAt)), 'startedAt must be a parseable timestamp');
  assert.strictEqual(readMarkerSession(), 'sess-abc_123.X');
});

// ── invalid session ids are rejected without writing ────────────────────────

withMarkerFile(file => {
  assert.strictEqual(writeMarker(''), false);
  assert.strictEqual(writeMarker(null), false);
  assert.strictEqual(writeMarker('has spaces'), false);
  assert.strictEqual(writeMarker("id'; rm -rf /"), false);
  assert.strictEqual(writeMarker('x'.repeat(129)), false);
  assert.strictEqual(fs.existsSync(file), false, 'no marker file may exist after rejected writes');
});

// ── missing, stale and corrupted markers all mean "no fallback" ─────────────

withMarkerFile(() => {
  assert.strictEqual(readMarkerSession(), null, 'missing marker must read as null');
});

withMarkerFile(file => {
  assert.strictEqual(writeMarker('sess-fresh'), true);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  const startedAt = Date.parse(written.startedAt);
  const past25h = startedAt + 25 * 60 * 60 * 1000;
  assert.strictEqual(readMarkerSession({ now: past25h }), null, 'a marker older than the window must be stale');
  assert.strictEqual(readMarkerSession({ now: startedAt + 1000 }), 'sess-fresh', 'a fresh marker must resolve');
  assert.strictEqual(readMarkerSession({ now: startedAt - 1000 }), null, 'a marker from the future must not resolve');
});

withMarkerFile(file => {
  fs.writeFileSync(file, 'not json at all');
  assert.strictEqual(readMarkerSession(), null, 'corrupted marker must read as null');
  fs.writeFileSync(file, JSON.stringify({ session: 'bad id!', startedAt: new Date().toISOString() }));
  assert.strictEqual(readMarkerSession(), null, 'marker with invalid id must read as null');
  fs.writeFileSync(file, JSON.stringify({ session: 'sess-ok', startedAt: 'yesterday-ish' }));
  assert.strictEqual(readMarkerSession(), null, 'marker with unparseable startedAt must read as null');
});

// ── resolveMetricContext fallback chain ─────────────────────────────────────

withMarkerFile(() => {
  assert.strictEqual(writeMarker('sess-marker'), true);

  const withoutEnv = resolveMetricContext({ env: { EGC_PROJECT_ROOT: '/tmp/proj' } });
  assert.strictEqual(withoutEnv.session, 'sess-marker', 'marker must fill the session when env has none');

  const withEnv = resolveMetricContext({ env: { EGC_SESSION_ID: 'sess-env', EGC_PROJECT_ROOT: '/tmp/proj' } });
  assert.strictEqual(withEnv.session, 'sess-env', 'env must always win over the marker');
});

withMarkerFile(() => {
  const context = resolveMetricContext({ env: { EGC_PROJECT_ROOT: '/tmp/proj' } });
  assert.strictEqual(context.session, 'unknown', 'no env and no marker must keep the unknown scope');
});

console.log('crusher-session-marker: all assertions passed');
