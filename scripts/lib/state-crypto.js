'use strict';

// Read-side decryption for egc-memory state files. The memory server encrypts
// every state write as: "EGC1:" magic + 12-byte IV + 16-byte GCM auth tag +
// AES-256-GCM ciphertext, keyed by ~/.egc/encryption.key (32 bytes as hex).
// Hooks and watchers only read state, so this module never creates or rotates
// the key; the write side lives in mcp/servers/egc-memory/src/encryption.ts.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAGIC = 'EGC1:';
const MAGIC_BYTES = Buffer.byteLength(MAGIC, 'utf-8');
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

function defaultKeyPath() {
  return path.join(os.homedir(), '.egc', 'encryption.key');
}

function isEncryptedBuffer(data) {
  return Buffer.isBuffer(data)
    && data.length >= MAGIC_BYTES
    && data.subarray(0, MAGIC_BYTES).toString('utf-8') === MAGIC;
}

function loadKey(keyPath) {
  const hex = fs.readFileSync(keyPath || defaultKeyPath(), 'utf-8').trim();
  const key = Buffer.from(hex, 'hex');
  return key.length === 32 ? key : null;
}

// Returns plaintext, or null when the payload cannot be authenticated and
// decrypted (missing or malformed key, truncated or tampered ciphertext).
function decryptStateBuffer(data, keyPath) {
  try {
    const key = loadKey(keyPath);
    if (!key) return null;
    const iv = data.subarray(MAGIC_BYTES, MAGIC_BYTES + IV_BYTES);
    const authTag = data.subarray(MAGIC_BYTES + IV_BYTES, MAGIC_BYTES + IV_BYTES + AUTH_TAG_BYTES);
    const ciphertext = data.subarray(MAGIC_BYTES + IV_BYTES + AUTH_TAG_BYTES);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext, undefined, 'utf-8') + decipher.final('utf-8');
  } catch {
    return null;
  }
}

// Reads a state file as plaintext: legacy plaintext passes through, EGC1
// payloads are decrypted, and unreadable content resolves to null so callers
// can stay silent instead of surfacing ciphertext.
function readStateFileDecrypted(filePath, keyPath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (!isEncryptedBuffer(raw)) return raw.toString('utf-8');
  return decryptStateBuffer(raw, keyPath);
}

module.exports = {
  MAGIC,
  isEncryptedBuffer,
  decryptStateBuffer,
  readStateFileDecrypted,
};
