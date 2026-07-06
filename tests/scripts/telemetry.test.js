/**
 * Tests for scripts/lib/telemetry.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'egc-telemetry-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function loadTelemetry(homeDir) {
  const origHome = process.env.HOME;
  const origUser = process.env.USERPROFILE;
  
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  Object.keys(require.cache).forEach((k) => {
    if (k.includes('telemetry')) delete require.cache[k];
  });

  const mod = require('../../scripts/lib/telemetry');

  if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
  if (origUser !== undefined) process.env.USERPROFILE = origUser; else delete process.env.USERPROFILE;

  return mod;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

async function runTests() {
  console.log('\n=== Testing telemetry.js ===\n');

  let passed = 0;
  let failed = 0;

  // readConsent
  if (await test('readConsent returns null when file does not exist', () => {
    const dir = createTempDir();
    try {
      const { readConsent } = loadTelemetry(dir);
      assert.strictEqual(readConsent(), null);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (await test('readConsent returns consent object with enabled=true', () => {
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

  if (await test('readConsent returns consent object with enabled=false', () => {
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

  if (await test('readConsent returns null on invalid JSON', () => {
    const dir = createTempDir();
    try {
      const egcDir = path.join(dir, '.egc');
      fs.mkdirSync(egcDir, { recursive: true });
      fs.writeFileSync(path.join(egcDir, 'telemetry.json'), 'not-json', 'utf8');
      const { readConsent } = loadTelemetry(dir);
      assert.strictEqual(readConsent(), null);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (await test('readConsent returns null when enabled field is missing', () => {
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
  if (await test('writeConsent creates .egc dir and writes enabled=true', () => {
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

  if (await test('writeConsent writes enabled=false correctly', () => {
    const dir = createTempDir();
    try {
      const { writeConsent } = loadTelemetry(dir);
      writeConsent(false);
      const filePath = path.join(dir, '.egc', 'telemetry.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.strictEqual(data.enabled, false);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (await test('writeConsent overwrites existing consent file', () => {
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

  // ensureConsent
  if (await test('ensureConsent returns true when consent already enabled', async () => {
    const dir = createTempDir();
    try {
      const egcDir = path.join(dir, '.egc');
      fs.mkdirSync(egcDir, { recursive: true });
      fs.writeFileSync(path.join(egcDir, 'telemetry.json'),
        JSON.stringify({ enabled: true, version: 1 }), 'utf8');
      const { ensureConsent } = loadTelemetry(dir);
      const result = await ensureConsent();
      assert.strictEqual(result, true);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (await test('ensureConsent returns false when consent already disabled', async () => {
    const dir = createTempDir();
    try {
      const egcDir = path.join(dir, '.egc');
      fs.mkdirSync(egcDir, { recursive: true });
      fs.writeFileSync(path.join(egcDir, 'telemetry.json'),
        JSON.stringify({ enabled: false, version: 1 }), 'utf8');
      const { ensureConsent } = loadTelemetry(dir);
      const result = await ensureConsent();
      assert.strictEqual(result, false);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (await test('ensureConsent writes false and returns false in non-TTY', async () => {
    const dir = createTempDir();
    try {
      const { ensureConsent } = loadTelemetry(dir);
      const result = await ensureConsent();
      assert.strictEqual(result, false);
      const filePath = path.join(dir, '.egc', 'telemetry.json');
      assert.ok(fs.existsSync(filePath));
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.strictEqual(data.enabled, false);
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (await test('ensureConsent prompts via readline when stdin is TTY', async () => {
    const origCreate = readline.createInterface;
    readline.createInterface = () => ({
      question: (_prompt, cb) => cb('y'),
      close: () => {},
    });
    const origIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;

    const dir = createTempDir();
    try {
      const { ensureConsent } = loadTelemetry(dir);
      const result = await ensureConsent();
      assert.strictEqual(result, true);
      const filePath = path.join(dir, '.egc', 'telemetry.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.strictEqual(data.enabled, true);
    } finally {
      readline.createInterface = origCreate;
      process.stdin.isTTY = origIsTTY;
      cleanup(dir);
    }
  })) { passed++; } else { failed++; }

  if (await test('ensureConsent stores false when user declines in TTY', async () => {
    const origCreate = readline.createInterface;
    readline.createInterface = () => ({
      question: (_prompt, cb) => cb('n'),
      close: () => {},
    });
    const origIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;

    const dir = createTempDir();
    try {
      const { ensureConsent } = loadTelemetry(dir);
      const result = await ensureConsent();
      assert.strictEqual(result, false);
    } finally {
      readline.createInterface = origCreate;
      process.stdin.isTTY = origIsTTY;
      cleanup(dir);
    }
  })) { passed++; } else { failed++; }

  // ping
  if (await test('ping does not throw when consent is disabled', () => {
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

  if (await test('ping does not throw when no consent file exists', () => {
    const dir = createTempDir();
    try {
      const { ping } = loadTelemetry(dir);
      assert.doesNotThrow(() => ping('/cli/egc', 'EGC CLI'));
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  if (await test('ping fires fetch with correct URL when consent is enabled', () => {
    const dir = createTempDir();
    try {
      const egcDir = path.join(dir, '.egc');
      fs.mkdirSync(egcDir, { recursive: true });
      fs.writeFileSync(path.join(egcDir, 'telemetry.json'),
        JSON.stringify({ enabled: true, version: 1 }), 'utf8');

      let capturedUrl = null;
      const origFetch = global.fetch;
      global.fetch = (url) => { capturedUrl = url; return Promise.resolve({}); };

      const { ping } = loadTelemetry(dir);
      ping('/cli/install', 'EGC Install');

      global.fetch = origFetch;
      assert.ok(capturedUrl !== null, 'fetch should have been called');
      assert.strictEqual(new URL(capturedUrl).hostname, 'egc.goatcounter.com', 'URL should target GoatCounter host');
      const params = new URL(capturedUrl).searchParams;
      assert.ok(params.get('p') !== null, 'URL should include page path param');
    } finally { cleanup(dir); }
  })) { passed++; } else { failed++; }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
