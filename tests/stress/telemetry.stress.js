'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-tel-stress-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

// Load telemetry module with overridden HOME so it uses our temp dir
function loadTelemetry(homeDir) {
  // Purge cached module so TELEMETRY_FILE is re-evaluated with new HOME
  const modPath = require.resolve('../../scripts/lib/telemetry');
  delete require.cache[modPath];

  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    return require(modPath);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  }
}

// ─── tests ──────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n=== STRESS TEST: telemetry.js ===\n');

  // ── 1. Rapid sequential read/write without crash ───────────────────────────
  await test('500 sequential writeConsent+readConsent cycles do not corrupt data', () => {
    const tmpDir = createTempDir();
    try {
      const { readConsent, writeConsent } = loadTelemetry(tmpDir);
      for (let i = 0; i < 500; i++) {
        writeConsent(i % 2 === 0);
        const consent = readConsent();
        assert.ok(consent !== null, `cycle ${i}: readConsent returned null`);
        assert.strictEqual(typeof consent.enabled, 'boolean');
      }
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 2. Adversarial JSON payloads written directly to telemetry file ────────
  const malformedPayloads = [
    '',                                    // empty file
    '   ',                                 // whitespace only
    '{{{',                                 // invalid JSON
    'null',                                // valid JSON but not object
    '[]',                                  // array
    '{"enabled": "yes"}',                  // string instead of boolean
    '{"enabled": 1}',                      // number instead of boolean
    '{"enabled": null}',                   // null
    '{"version": 1}',                      // missing enabled
    '\uFEFF{"enabled": true}',             // BOM prefix
    '\uFEFF\uFEFF{"enabled": true}',       // double BOM
    '{"enabled": true, "extra": "' + 'A'.repeat(100_000) + '"}', // huge extra field
  ];

  for (const payload of malformedPayloads) {
    const label = payload.length > 40 ? payload.slice(0, 40) + '…' : JSON.stringify(payload);
    await test(`readConsent handles malformed payload: ${label}`, () => {
      const tmpDir = createTempDir();
      try {
        const egcDir = path.join(tmpDir, '.egc');
        fs.mkdirSync(egcDir, { recursive: true });
        fs.writeFileSync(path.join(egcDir, 'telemetry.json'), payload, 'utf8');

        const { readConsent } = loadTelemetry(tmpDir);
        let result;
        assert.doesNotThrow(() => {
          result = readConsent();
        }, `readConsent threw on payload: ${label}`);
        // Result must be null or a valid consent object — never an exception
        if (result !== null) {
          assert.strictEqual(typeof result.enabled, 'boolean');
        }
      } finally {
        cleanup(tmpDir);
      }
    });
  }

  // ── 3. Telemetry file replaced by a directory ──────────────────────────────
  await test('readConsent does not crash when telemetry path is a directory', () => {
    const tmpDir = createTempDir();
    try {
      const egcDir = path.join(tmpDir, '.egc');
      // Create 'telemetry.json' as a *directory* instead of a file
      fs.mkdirSync(path.join(egcDir, 'telemetry.json'), { recursive: true });

      const { readConsent } = loadTelemetry(tmpDir);
      assert.doesNotThrow(() => readConsent());
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 4. writeConsent with deeply nested missing directories ─────────────────
  await test('writeConsent creates nested dirs on first call', () => {
    const tmpDir = createTempDir();
    try {
      // Do NOT pre-create the .egc directory
      const { writeConsent, readConsent } = loadTelemetry(tmpDir);
      assert.doesNotThrow(() => writeConsent(true));
      const consent = readConsent();
      assert.ok(consent !== null);
      assert.strictEqual(consent.enabled, true);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 5. writeConsent called 1000 times — no file descriptor leak ────────────
  await test('1000 writeConsent calls without file descriptor leak', () => {
    const tmpDir = createTempDir();
    try {
      const { writeConsent } = loadTelemetry(tmpDir);
      for (let i = 0; i < 1000; i++) {
        writeConsent(i % 2 === 0);
      }
      // If FDs leaked, the OS would have thrown EMFILE by now
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 6. Telemetry file with OS-max filename length ─────────────────────────
  await test('readConsent is stable when .egc contains many other files', () => {
    const tmpDir = createTempDir();
    try {
      const egcDir = path.join(tmpDir, '.egc');
      fs.mkdirSync(egcDir, { recursive: true });
      // Fill directory with noise
      for (let i = 0; i < 200; i++) {
        fs.writeFileSync(path.join(egcDir, `noise-${i}.json`), '{}');
      }
      fs.writeFileSync(path.join(egcDir, 'telemetry.json'), JSON.stringify({ enabled: true, version: 1 }));

      const { readConsent } = loadTelemetry(tmpDir);
      const consent = readConsent();
      assert.ok(consent !== null);
      assert.strictEqual(consent.enabled, true);
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 7. ping does not throw regardless of fetch availability ───────────────
  await test('ping never throws even if global fetch is broken', () => {
    const tmpDir = createTempDir();
    try {
      const { writeConsent, ping } = loadTelemetry(tmpDir);
      writeConsent(true);

      const origFetch = global.fetch;
      global.fetch = () => { throw new Error('network dead'); };
      try {
        assert.doesNotThrow(() => ping('/stress-test', 'Stress Test'));
      } finally {
        global.fetch = origFetch;
      }
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 8. ping with fetch that returns rejected promise ──────────────────────
  await test('ping survives when fetch returns a rejected promise', async () => {
    const tmpDir = createTempDir();
    try {
      const { writeConsent, ping } = loadTelemetry(tmpDir);
      writeConsent(true);

      const origFetch = global.fetch;
      global.fetch = () => Promise.reject(new Error('connection refused'));
      try {
        // ping should not throw synchronously
        assert.doesNotThrow(() => ping('/stress-test', 'Rejected'));
        // Give promise a tick to resolve/reject — should not propagate
        await new Promise(r => setTimeout(r, 10));
      } finally {
        global.fetch = origFetch;
      }
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 9. readConsent on read-only file ──────────────────────────────────────
  await test('readConsent handles read-only telemetry file', () => {
    if (process.platform === 'win32') {
      // chmod is unreliable on Windows — skip without touching counters.
      // test() will count this as a pass since no exception is thrown.
      console.log('    (skipped: chmod unreliable on Windows)');
      return;
    }
    const tmpDir = createTempDir();
    try {
      const egcDir = path.join(tmpDir, '.egc');
      fs.mkdirSync(egcDir, { recursive: true });
      const filePath = path.join(egcDir, 'telemetry.json');
      fs.writeFileSync(filePath, JSON.stringify({ enabled: true, version: 1 }));
      fs.chmodSync(filePath, 0o000);
      try {
        const { readConsent } = loadTelemetry(tmpDir);
        assert.doesNotThrow(() => readConsent());
      } finally {
        fs.chmodSync(filePath, 0o644);
      }
    } finally {
      cleanup(tmpDir);
    }
  });

  // ── 10. Telemetry file with Unicode path in home directory ─────────────────
  await test('readConsent works when home dir contains unicode characters', () => {
    const baseDir = createTempDir();
    const unicodeDir = path.join(baseDir, '用户目录-кириллица-home');
    try {
      fs.mkdirSync(unicodeDir, { recursive: true });
      const { writeConsent, readConsent } = loadTelemetry(unicodeDir);
      writeConsent(false);
      const consent = readConsent();
      assert.ok(consent !== null);
      assert.strictEqual(consent.enabled, false);
    } finally {
      cleanup(baseDir);
    }
  });

  // ─── summary ────────────────────────────────────────────────────────────────
  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  ✗ ${f.name}: ${f.error}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Unexpected runner error:', err);
  process.exit(1);
});
