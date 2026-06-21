/**
 * Tests for scripts/lib/telemetry.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-telemetry-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function loadTelemetry(homeDir) {
  const HOME_KEY = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const orig = process.env[HOME_KEY];
  process.env[HOME_KEY] = homeDir;
  if (process.platform !== 'win32') process.env.USERPROFILE = homeDir;

  Object.keys(require.cache).forEach((k) => {
    if (k.includes('telemetry')) delete require.cache[k];
  });

  const mod = require('../../scripts/lib/telemetry');

  process.env[HOME_KEY] = orig;

  return mod;
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing telemetry.js ===\n');

  let passed = 0;
  let failed = 0;

  // readConsent
  if (test('readConsent returns null when file does not exist', () => {
    const dir = createTempDir();
    try {
      const { readConsent } = loadTelemetry(dir);
      assert.strictEqual(readConsent(), null);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (test('readConsent returns consent object with enabled=true', () => {
    const dir = createTempDir();
    try {
      const egcDir = path.join(dir, '.egc');
      fs.mkdirSync(egcDir, { recursive: true });
      fs.writeFileSync(path.join(egcDir, 'telemetry.json'),
        JSON.stringify({ enabled: true, version: 1 }), 'utf8');
      const { readConsent } = loadTelemetry(dir);
      const consent = readConsent();
      assert.strictEqual(consent.enabled, true);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (test('readConsent returns consent object with enabled=false', () => {
    const dir = createTempDir();
    try {
      const egcDir = path.join(dir, '.egc');
      fs.mkdirSync(egcDir, { recursive: true });
      fs.writeFileSync(path.join(egcDir, 'telemetry.json'),
        JSON.stringify({ enabled: false, version: 1 }), 'utf8');
      const { readConsent } = loadTelemetry(dir);
      assert.strictEqual(readConsent().enabled, false);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (test('readConsent returns null on invalid JSON', () => {
    const dir = createTempDir();
    try {
      const egcDir = path.join(dir, '.egc');
      fs.mkdirSync(egcDir, { recursive: true });
      fs.writeFileSync(path.join(egcDir, 'telemetry.json'), 'not-json', 'utf8');
      const { readConsent } = loadTelemetry(dir);
      assert.strictEqual(readConsent(), null);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (test('readConsent returns null when enabled field is missing', () => {
    const dir = createTempDir();
    try {
      const egcDir = path.join(dir, '.egc');
      fs.mkdirSync(egcDir, { recursive: true });
      fs.writeFileSync(path.join(egcDir, 'telemetry.json'),
        JSON.stringify({ version: 1 }), 'utf8');
      const { readConsent } = loadTelemetry(dir);
      assert.strictEqual(readConsent(), null);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  // writeConsent
  if (test('writeConsent creates .egc dir and writes enabled=true', () => {
    const dir = createTempDir();
    try {
      const { writeConsent } = loadTelemetry(dir);
      writeConsent(true);
      const filePath = path.join(dir, '.egc', 'telemetry.json');
      assert.ok(fs.existsSync(filePath));
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.strictEqual(data.enabled, true);
      assert.strictEqual(data.version, 1);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (test('writeConsent writes enabled=false correctly', () => {
    const dir = createTempDir();
    try {
      const { writeConsent } = loadTelemetry(dir);
      writeConsent(false);
      const filePath = path.join(dir, '.egc', 'telemetry.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.strictEqual(data.enabled, false);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (test('writeConsent overwrites existing consent file', () => {
    const dir = createTempDir();
    try {
      const egcDir = path.join(dir, '.egc');
      fs.mkdirSync(egcDir, { recursive: true });
      const filePath = path.join(egcDir, 'telemetry.json');
      fs.writeFileSync(filePath, JSON.stringify({ enabled: true, version: 1 }), 'utf8');
      const { writeConsent } = loadTelemetry(dir);
      writeConsent(false);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.strictEqual(data.enabled, false);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  // ping
  if (test('ping does not throw when consent is disabled', () => {
    const dir = createTempDir();
    try {
      const egcDir = path.join(dir, '.egc');
      fs.mkdirSync(egcDir, { recursive: true });
      fs.writeFileSync(path.join(egcDir, 'telemetry.json'),
        JSON.stringify({ enabled: false, version: 1 }), 'utf8');
      const { ping } = loadTelemetry(dir);
      assert.doesNotThrow(() => ping('/cli/egc', 'EGC CLI'));
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (test('ping does not throw when no consent file exists', () => {
    const dir = createTempDir();
    try {
      const { ping } = loadTelemetry(dir);
      assert.doesNotThrow(() => ping('/cli/egc', 'EGC CLI'));
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
