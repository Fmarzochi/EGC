/**
 * Tests for scripts/lib/state-crypto.js read-side decryption.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAGIC,
  isEncryptedBuffer,
  decryptStateBuffer,
  readStateFileDecrypted,
} = require('../../scripts/lib/state-crypto');

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

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

// Mirrors the write side in mcp/servers/egc-memory/src/encryption.ts so the
// fixtures match real server output without requiring a server build.
function encryptFixture(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return Buffer.concat([Buffer.from(MAGIC, 'utf-8'), iv, cipher.getAuthTag(), encrypted]);
}

function writeKeyFile(dir, key) {
  const keyPath = path.join(dir, 'encryption.key');
  fs.writeFileSync(keyPath, key.toString('hex'), 'utf-8');
  return keyPath;
}

function runTests() {
  console.log('\n=== Testing scripts/lib/state-crypto.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('isEncryptedBuffer detects the magic header', () => {
    const key = crypto.randomBytes(32);
    assert.strictEqual(isEncryptedBuffer(encryptFixture('state', key)), true);
    assert.strictEqual(isEncryptedBuffer(Buffer.from('# Project State\n')), false);
    assert.strictEqual(isEncryptedBuffer(Buffer.alloc(0)), false);
  })) passed++; else failed++;

  if (test('round-trips a state file encrypted with the server format', () => {
    const dir = createTempDir('state-crypto-');
    try {
      const key = crypto.randomBytes(32);
      const keyPath = writeKeyFile(dir, key);
      const plaintext = '# Project State\nupdated: 2026-07-08T05:46:59.901Z\n\n## Context\nsecret memory\n';
      const filePath = path.join(dir, 'main.md');
      fs.writeFileSync(filePath, encryptFixture(plaintext, key));

      assert.strictEqual(readStateFileDecrypted(filePath, keyPath), plaintext);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('legacy plaintext passes through unchanged', () => {
    const dir = createTempDir('state-crypto-');
    try {
      const filePath = path.join(dir, 'flat.md');
      fs.writeFileSync(filePath, '# Project State\nplain memory\n', 'utf-8');

      assert.strictEqual(
        readStateFileDecrypted(filePath, path.join(dir, 'missing.key')),
        '# Project State\nplain memory\n'
      );
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('returns null when the key file is missing', () => {
    const dir = createTempDir('state-crypto-');
    try {
      const key = crypto.randomBytes(32);
      const filePath = path.join(dir, 'main.md');
      fs.writeFileSync(filePath, encryptFixture('secret', key));

      assert.strictEqual(readStateFileDecrypted(filePath, path.join(dir, 'missing.key')), null);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('returns null when the key file is malformed', () => {
    const dir = createTempDir('state-crypto-');
    try {
      const key = crypto.randomBytes(32);
      const keyPath = path.join(dir, 'encryption.key');
      fs.writeFileSync(keyPath, 'not-hex-and-too-short', 'utf-8');
      const filePath = path.join(dir, 'main.md');
      fs.writeFileSync(filePath, encryptFixture('secret', key));

      assert.strictEqual(readStateFileDecrypted(filePath, keyPath), null);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('returns null for tampered ciphertext', () => {
    const dir = createTempDir('state-crypto-');
    try {
      const key = crypto.randomBytes(32);
      const keyPath = writeKeyFile(dir, key);
      const payload = encryptFixture('untampered state', key);
      payload[payload.length - 1] ^= 0xff;

      assert.strictEqual(decryptStateBuffer(payload, keyPath), null);
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  if (test('returns null for a missing state file', () => {
    const dir = createTempDir('state-crypto-');
    try {
      assert.strictEqual(
        readStateFileDecrypted(path.join(dir, 'nope.md'), path.join(dir, 'nope.key')),
        null
      );
    } finally {
      cleanup(dir);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
