'use strict';
/**
 * Tests for mcp/servers/egc-memory/src/integrity.ts (issue #580)
 *
 * Covers key generation, HMAC write/verify, tamper detection, and
 * missing-sidecar detection. Tests run against the compiled build output.
 *
 * Run with: node tests/egc-memory-integrity.test.js
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function test(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

let passed = 0;
let failed = 0;

const buildPath = path.join(
  __dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'integrity.js'
);

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-memory first.');
  process.exit(0);
}

const { loadOrCreateKey, computeHmac, writeHmac, verifyHmac } = require(buildPath);

console.log('\n=== Testing egc-memory integrity (issue #580) ===\n');

// ── loadOrCreateKey ──────────────────────────────────────────────────────────

if (test('loadOrCreateKey: returns a 32-byte Buffer', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-integrity-test-'));
  try {
    // Override HOME so key is written to tmpDir
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const key = loadOrCreateKey();
    process.env.HOME = origHome;
    assert.ok(Buffer.isBuffer(key), 'should be a Buffer');
    assert.strictEqual(key.length, 32, 'should be 32 bytes');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('loadOrCreateKey: key file is created with mode 0600', () => {
  // KEY_PATH is resolved at module load time from os.homedir()
  const keyPath = path.join(os.homedir(), '.egc', 'integrity.key');
  loadOrCreateKey();
  assert.ok(fs.existsSync(keyPath), 'key file should exist');
  const mode = fs.statSync(keyPath).mode & 0o777;
  assert.strictEqual(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
})) passed++; else failed++;

if (test('loadOrCreateKey: returns same key on second call', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-integrity-test-'));
  try {
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const key1 = loadOrCreateKey();
    const key2 = loadOrCreateKey();
    process.env.HOME = origHome;
    assert.ok(key1.equals(key2), 'keys should be identical on second load');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

// ── computeHmac ──────────────────────────────────────────────────────────────

if (test('computeHmac: returns 64-char lowercase hex string', () => {
  const key = crypto.randomBytes(32);
  const mac = computeHmac('hello world', key);
  assert.strictEqual(typeof mac, 'string');
  assert.strictEqual(mac.length, 64);
  assert.ok(/^[0-9a-f]{64}$/.test(mac), 'should be lowercase hex');
})) passed++; else failed++;

if (test('computeHmac: same content + key produces same HMAC', () => {
  const key = crypto.randomBytes(32);
  const mac1 = computeHmac('test content', key);
  const mac2 = computeHmac('test content', key);
  assert.strictEqual(mac1, mac2);
})) passed++; else failed++;

if (test('computeHmac: different content produces different HMAC', () => {
  const key = crypto.randomBytes(32);
  const mac1 = computeHmac('content A', key);
  const mac2 = computeHmac('content B', key);
  assert.notStrictEqual(mac1, mac2);
})) passed++; else failed++;

// ── writeHmac + verifyHmac ───────────────────────────────────────────────────

if (test('verifyHmac: returns { ok: true } for untampered file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-integrity-test-'));
  try {
    const key = crypto.randomBytes(32);
    const stateFile = path.join(tmpDir, 'state.md');
    const content = '# Project State\n- decision: use HMAC\n';
    fs.writeFileSync(stateFile, content, 'utf-8');
    writeHmac(stateFile, content, key);
    assert.ok(fs.existsSync(`${stateFile}.hmac`), 'sidecar should exist');
    const result = verifyHmac(stateFile, content, key);
    assert.deepStrictEqual(result, { ok: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('verifyHmac: returns { ok: false, reason: "hmac_mismatch" } for tampered content', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-integrity-test-'));
  try {
    const key = crypto.randomBytes(32);
    const stateFile = path.join(tmpDir, 'state.md');
    const original = '# Project State\n- decision: use HMAC\n';
    fs.writeFileSync(stateFile, original, 'utf-8');
    writeHmac(stateFile, original, key);
    // Tamper with the file
    const tampered = original + '- injected: malicious line\n';
    const result = verifyHmac(stateFile, tampered, key);
    assert.deepStrictEqual(result, { ok: false, reason: 'hmac_mismatch' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('verifyHmac: returns { ok: false, reason: "missing_sidecar" } when no .hmac file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-integrity-test-'));
  try {
    const key = crypto.randomBytes(32);
    const stateFile = path.join(tmpDir, 'state.md');
    const content = '# Project State\n';
    fs.writeFileSync(stateFile, content, 'utf-8');
    // No writeHmac call — sidecar absent
    const result = verifyHmac(stateFile, content, key);
    assert.deepStrictEqual(result, { ok: false, reason: 'missing_sidecar' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('verifyHmac: returns hmac_mismatch for malformed sidecar content', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-integrity-test-'));
  try {
    const key = crypto.randomBytes(32);
    const stateFile = path.join(tmpDir, 'state.md');
    const content = '# Project State\n';
    fs.writeFileSync(stateFile, content, 'utf-8');
    // Write a malformed sidecar
    fs.writeFileSync(`${stateFile}.hmac`, 'not-a-valid-hex-string', 'utf-8');
    const result = verifyHmac(stateFile, content, key);
    assert.deepStrictEqual(result, { ok: false, reason: 'hmac_mismatch' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('writeHmac: sidecar file has mode 0600', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-integrity-test-'));
  try {
    const key = crypto.randomBytes(32);
    const stateFile = path.join(tmpDir, 'state.md');
    const content = '# Project State\n';
    fs.writeFileSync(stateFile, content, 'utf-8');
    writeHmac(stateFile, content, key);
    const hmacPath = `${stateFile}.hmac`;
    const mode = fs.statSync(hmacPath).mode & 0o777;
    assert.strictEqual(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
