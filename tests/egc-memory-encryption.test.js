'use strict';
/**
 * Tests for mcp/servers/egc-memory/src/encryption.ts
 *
 * Covers encrypt/decrypt round-trip and the loadOrCreateEncKey TOCTOU
 * race condition: two processes racing to create ~/.egc/encryption.key
 * before it exists must not let the loser silently overwrite the
 * winner's key with its own, which would leave the loser holding a key
 * that can never decrypt state files written under the winner's key.
 *
 * Run with: node tests/egc-memory-encryption.test.js
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
  __dirname, '..', 'mcp', 'servers', 'egc-memory', 'build', 'encryption.js'
);

if (!fs.existsSync(buildPath)) {
  console.log('[SKIP] build not found. Run npm run build in mcp/servers/egc-memory first.');
  process.exit(0);
}

const { loadOrCreateEncKey, encryptState, decryptState, isEncrypted, writeStateFile, readStateFile, quarantineUndecryptableStateFile } = require(buildPath);

console.log('\n=== Testing egc-memory encryption ===\n');

// ── encrypt/decrypt round-trip ──────────────────────────────────────────────

if (test('encryptState/decryptState: round-trips plaintext', () => {
  const key = crypto.randomBytes(32);
  const plaintext = 'hello state file';
  const encrypted = encryptState(plaintext, key);
  assert.ok(isEncrypted(encrypted), 'should carry the EGC1 magic header');
  const decrypted = decryptState(encrypted, key);
  assert.strictEqual(decrypted, plaintext);
})) passed++; else failed++;

if (test('decryptState: throws on wrong key (auth tag mismatch)', () => {
  const keyA = crypto.randomBytes(32);
  const keyB = crypto.randomBytes(32);
  const encrypted = encryptState('secret', keyA);
  assert.throws(() => decryptState(encrypted, keyB));
})) passed++; else failed++;

if (test('writeStateFile/readStateFile: round-trips through disk', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-encryption-test-'));
  try {
    const key = crypto.randomBytes(32);
    const filePath = path.join(tmpDir, 'state.md');
    writeStateFile(filePath, '# Project State\ncontent here', key);
    const content = readStateFile(filePath, key);
    assert.strictEqual(content, '# Project State\ncontent here');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

// ── loadOrCreateEncKey ───────────────────────────────────────────────────────

if (test('loadOrCreateEncKey: returns a 32-byte Buffer and creates the file with mode 0600', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-encryption-test-'));
  try {
    const keyPath = path.join(tmpDir, 'encryption.key');
    const key = loadOrCreateEncKey(keyPath);
    assert.ok(Buffer.isBuffer(key));
    assert.strictEqual(key.length, 32);
    assert.ok(fs.existsSync(keyPath));
    const mode = fs.statSync(keyPath).mode & 0o777;
    assert.strictEqual(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('loadOrCreateEncKey: warns (does not throw) when chmod on the key file fails (audit EGC-128, low)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-encryption-test-'));
  const keyPath = path.join(tmpDir, 'encryption.key');
  const originalChmodSync = fs.chmodSync;
  const originalConsoleError = console.error;
  const errorLines = [];
  console.error = (...args) => errorLines.push(args.join(' '));
  fs.chmodSync = (target, mode) => {
    if (target === keyPath) {
      throw new Error('EPERM: simulated filesystem without permission bit support');
    }
    return originalChmodSync(target, mode);
  };
  try {
    const key = loadOrCreateEncKey(keyPath);
    assert.ok(Buffer.isBuffer(key), 'should still return a usable key despite the chmod failure');
    assert.strictEqual(key.length, 32);
    assert.ok(
      errorLines.some(line => line.includes(keyPath) && line.includes('0600')),
      `expected a warning naming the key path and the intended mode, got: ${JSON.stringify(errorLines)}`
    );
  } finally {
    fs.chmodSync = originalChmodSync;
    console.error = originalConsoleError;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('loadOrCreateEncKey: returns the same key on a second call (loads, does not regenerate)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-encryption-test-'));
  try {
    const keyPath = path.join(tmpDir, 'encryption.key');
    const key1 = loadOrCreateEncKey(keyPath);
    const key2 = loadOrCreateEncKey(keyPath);
    assert.ok(key1.equals(key2));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('loadOrCreateEncKey: throws on a malformed key file instead of silently regenerating', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-encryption-test-'));
  try {
    const keyPath = path.join(tmpDir, 'encryption.key');
    fs.writeFileSync(keyPath, 'not-valid-hex-and-wrong-length', { mode: 0o600 });
    assert.throws(() => loadOrCreateEncKey(keyPath), /malformed/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

if (test('loadOrCreateEncKey: TOCTOU race — a concurrent winner\'s key is read back, never silently overwritten', () => {
  // Regression test for the bug behind "Failed to decrypt existing state
  // file. The encryption key may have changed." Two egc-memory processes
  // can both observe !existsSync(keyPath) before either writes (e.g. two
  // agents/sessions starting close together with no ~/.egc/encryption.key
  // yet). Simulate the loser's view: existsSync says false, but a winner
  // has already written a real key to disk by the time our write executes.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-encryption-test-'));
  const keyPath = path.join(tmpDir, 'encryption.key');
  const winnerKey = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, winnerKey.toString('hex'), { encoding: 'utf-8', mode: 0o600 });

  const origExistsSync = fs.existsSync;
  fs.existsSync = (p) => (p === keyPath ? false : origExistsSync(p));
  try {
    const result = loadOrCreateEncKey(keyPath);
    assert.ok(
      result.equals(winnerKey),
      'loser must read back the key that actually won the race on disk, not keep its own discarded key in memory'
    );
    const onDisk = Buffer.from(fs.readFileSync(keyPath, 'utf-8').trim(), 'hex');
    assert.ok(onDisk.equals(winnerKey), 'the winner\'s key on disk must remain untouched');
  } finally {
    fs.existsSync = origExistsSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

// ── quarantineUndecryptableStateFile ────────────────────────────────────────

if (test('quarantineUndecryptableStateFile: renames the corrupted file to a backup path and leaves it readable', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-encryption-test-'));
  try {
    const filePath = path.join(tmpDir, 'state.md');
    fs.writeFileSync(filePath, 'garbage-not-decryptable', { mode: 0o600 });

    const backupPath = quarantineUndecryptableStateFile(filePath);

    assert.ok(!fs.existsSync(filePath), 'original path must no longer exist so a fresh write can take its place');
    assert.ok(fs.existsSync(backupPath), 'backup must exist so the corrupted bytes are not lost');
    assert.ok(backupPath.startsWith(`${filePath}.corrupted-backup-`), 'backup path must be a sibling of the original, clearly marked as corrupted');
    assert.strictEqual(fs.readFileSync(backupPath, 'utf-8'), 'garbage-not-decryptable', 'backup must preserve the original bytes untouched');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})) passed++; else failed++;

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
