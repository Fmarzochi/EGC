'use strict';

// Encryption for egc-memory state files, mirroring
// mcp/servers/egc-memory/src/encryption.ts (JS mirror pattern also used by
// global-state.js in this directory -- keep both in sync). Every state write
// is: "EGC1:" magic + 12-byte IV + 16-byte GCM auth tag + AES-256-GCM
// ciphertext, keyed by ~/.egc/encryption.key (32 bytes as hex).
//
// Originally this module was read-only ("hooks only read state"), but the
// PreCompact snapshot hook (state-snapshot.js) needs a guaranteed direct
// write even when the AI is unavailable to call the MCP server's own
// update_state. Reading an encrypted file as plain UTF-8 and writing the
// result back as plain UTF-8 -- the bug this module's write side fixes --
// silently corrupts the ciphertext (lossy replacement-character mangling on
// the read, then a mismatched re-encode on the write), which then fails
// decryption later with what looks like a wrong-key error but never was one.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAGIC = 'EGC1:';
const MAGIC_BYTES = Buffer.byteLength(MAGIC, 'utf-8');
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

// getStateDir() (branch-state.js) and the hooks that call it already accept
// an explicit HOME override so tests can isolate state under a temp dir.
// This must resolve the same HOME on every platform -- os.homedir() alone
// prefers USERPROFILE over HOME on Windows, so a HOME-overridden test still
// hit the real user profile here, encrypted with the wrong key, and failed
// to decrypt (Windows-only CI failures on PR #1168).
function defaultKeyPath() {
  return path.join(process.env.HOME || os.homedir(), '.egc', 'encryption.key');
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

// Mirrors loadOrCreateEncKey() in encryption.ts: same atomic
// write-tmp-then-link publish so a concurrent creator (the MCP server, or
// another hook invocation) can never observe a truncated key, and the same
// "never silently regenerate an existing key" safety rule. Only the create
// path is new here -- reads still go through loadKey() elsewhere in this file.
// A key file must be private. The permission bits are set and then read
// back: where the filesystem keeps POSIX bits a file still readable by the
// group or others after the chmod is a hard error, because the key would
// sit exposed with nothing but a log line to say so; on Windows there are
// no bits to tighten, so the call is a no-op there.
function assertPrivateKeyFile(filePath) {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (chmodErr) {
    throw new Error(`[EGC] Could not set 0600 permissions on ${filePath}: ${chmodErr.message}. The key must not be readable by other users; fix the permissions and restart.`, { cause: chmodErr });

  }
  const mode = fs.statSync(filePath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`[EGC] ${filePath} is readable by other users (mode ${mode.toString(8)}) and the filesystem did not accept 0600. Move the key to a filesystem with POSIX permissions.`);
  }
}

function loadOrCreateKeySync(keyPath) {
  const resolvedPath = keyPath || defaultKeyPath();
  const dir = path.dirname(resolvedPath);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* may already exist */ }

  if (fs.existsSync(resolvedPath)) {
    const key = loadKey(resolvedPath);
    assertPrivateKeyFile(resolvedPath);
    return key;
  }

  const key = crypto.randomBytes(32);
  const tmpPath = `${resolvedPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmpPath, key.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.linkSync(tmpPath, resolvedPath);
      assertPrivateKeyFile(resolvedPath);
      return key;
    } catch (e) {
      if (e?.code === 'EEXIST') return loadKey(resolvedPath);
      throw e;
    }
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* already renamed away */ }
  }
}

// Returns MAGIC + IV + authTag + ciphertext, the exact wire format
// decryptStateBuffer() (and encryption.ts's decryptState()) expect.
function encryptStateBuffer(plaintext, keyPath) {
  const key = loadOrCreateKeySync(keyPath);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(MAGIC, 'utf-8'), iv, authTag, encrypted]);
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
  assertPrivateKeyFile,
  MAGIC,
  isEncryptedBuffer,
  decryptStateBuffer,
  readStateFileDecrypted,
  loadOrCreateKeySync,
  encryptStateBuffer,
};
