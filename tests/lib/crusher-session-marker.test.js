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

let failed = 0;
const pending = [];

function report(name, error) {
  if (error === undefined) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${name}`);
  console.log(`    Error: ${error.message}`);
}

// Sync and async alike: a returned promise is awaited before the exit code is
// decided, so a rejected async case reports ✗ instead of being swallowed.
function test(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      pending.push(ret.then(() => report(name), error => report(name, error)));
      return;
    }
    report(name);
  } catch (error) {
    report(name, error);
  }
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function setMtime(file, epochMs) {
  fs.utimesSync(file, new Date(epochMs), new Date(epochMs));
}

console.log('\ncrusher session marker\n');

test('EGC_SESSION_MARKER_FILE overrides the default path', () => {
  withMarkerFile(file => {
    assert.strictEqual(markerFilePath(), file);
  });
});

test('write + read round trip preserves session, source and startedAt', () => {
  withMarkerFile(file => {
    assert.strictEqual(writeMarker('sess-abc_123.X', { source: 'claude' }), true);
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(row.session, 'sess-abc_123.X');
    assert.strictEqual(row.source, 'claude');
    assert.ok(Number.isFinite(Date.parse(row.startedAt)), 'startedAt must be a parseable timestamp');
    assert.strictEqual(readMarkerSession(), 'sess-abc_123.X');
  });
});

test('invalid session ids are rejected without writing a file', () => {
  withMarkerFile(file => {
    assert.strictEqual(writeMarker(''), false);
    assert.strictEqual(writeMarker(null), false);
    assert.strictEqual(writeMarker('has spaces'), false);
    assert.strictEqual(writeMarker("id'; rm -rf /"), false);
    assert.strictEqual(writeMarker('x'.repeat(129)), false);
    assert.strictEqual(fs.existsSync(file), false);
  });
});

test('missing marker reads as null', () => {
  withMarkerFile(() => {
    assert.strictEqual(readMarkerSession(), null);
  });
});

test('marker staleness is measured from mtime, both directions', () => {
  withMarkerFile(file => {
    assert.strictEqual(writeMarker('sess-fresh'), true);
    const now = Date.now();
    setMtime(file, now - 25 * 60 * 60 * 1000);
    assert.strictEqual(readMarkerSession({ now }), null, 'a marker untouched for >24h must be stale');
    setMtime(file, now - 1000);
    assert.strictEqual(readMarkerSession({ now }), 'sess-fresh', 'a recently touched marker must resolve');
    setMtime(file, now + 60 * 60 * 1000);
    assert.strictEqual(readMarkerSession({ now }), null, 'a marker from the future must not resolve');
  });
});

test('successful reads refresh mtime so live sessions outlive the window', () => {
  withMarkerFile(file => {
    assert.strictEqual(writeMarker('sess-live'), true);
    const now = Date.now();
    setMtime(file, now - 23 * 60 * 60 * 1000);
    assert.strictEqual(readMarkerSession({ now }), 'sess-live');
    const refreshed = fs.statSync(file).mtimeMs;
    assert.ok(Math.abs(refreshed - now) < 5000, 'a successful read must touch the marker to now');
    assert.strictEqual(
      readMarkerSession({ now: now + 23 * 60 * 60 * 1000 }),
      'sess-live',
      'the refreshed marker must survive past the original window'
    );
  });
});

test('stale reads do not refresh the marker', () => {
  withMarkerFile(file => {
    assert.strictEqual(writeMarker('sess-dead'), true);
    const now = Date.now();
    const old = now - 25 * 60 * 60 * 1000;
    setMtime(file, old);
    assert.strictEqual(readMarkerSession({ now }), null);
    const after = fs.statSync(file).mtimeMs;
    assert.ok(Math.abs(after - old) < 5000, 'a stale marker must keep its old mtime');
  });
});

test('corrupted body, invalid id and bad timestamps read as null', () => {
  withMarkerFile(file => {
    fs.writeFileSync(file, 'not json at all');
    assert.strictEqual(readMarkerSession(), null);
    fs.writeFileSync(file, JSON.stringify({ session: 'bad id!', startedAt: new Date().toISOString() }));
    assert.strictEqual(readMarkerSession(), null);
    fs.writeFileSync(file, JSON.stringify({ session: 'sess-ok', startedAt: 'yesterday-ish' }));
    assert.strictEqual(readMarkerSession(), null);
  });
});

test('the startedAt lifetime cap expires a marker no matter how fresh its mtime', () => {
  withMarkerFile(file => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    const sixDaysAgo = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString();

    fs.writeFileSync(file, JSON.stringify({ session: 'sess-old', source: 'claude', startedAt: eightDaysAgo }));
    setMtime(file, now - 1000);
    assert.strictEqual(readMarkerSession({ now }), null, 'past the lifetime cap even a touched marker must expire');

    fs.writeFileSync(file, JSON.stringify({ session: 'sess-week', source: 'claude', startedAt: sixDaysAgo }));
    setMtime(file, now - 1000);
    assert.strictEqual(readMarkerSession({ now }), 'sess-week', 'within the cap a fresh marker must resolve');
  });
});

test('a rejected async test reports as a failure (harness self-check)', () => {
  const before = failed;
  test('async harness probe (expected ✗)', () => Promise.reject(new Error('probe')));
  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    assert.strictEqual(failed, before + 1, 'the async rejection must increment failed');
    failed = before;
  });
});

test('resolveMetricContext falls back to the marker only when env has no session', () => {
  withMarkerFile(() => {
    assert.strictEqual(writeMarker('sess-marker'), true);

    const withoutEnv = resolveMetricContext({ env: { EGC_PROJECT_ROOT: '/tmp/proj' } });
    assert.strictEqual(withoutEnv.session, 'sess-marker');

    const withEnv = resolveMetricContext({ env: { EGC_SESSION_ID: 'sess-env', EGC_PROJECT_ROOT: '/tmp/proj' } });
    assert.strictEqual(withEnv.session, 'sess-env');
  });
});

test('no env and no marker keeps the unknown scope', () => {
  withMarkerFile(() => {
    const context = resolveMetricContext({ env: { EGC_PROJECT_ROOT: '/tmp/proj' } });
    assert.strictEqual(context.session, 'unknown');
  });
});

Promise.all(pending).then(() => {
  console.log(failed ? `\n${failed} failed\n` : '\nall passed\n');
  process.exit(failed ? 1 : 0);
});
