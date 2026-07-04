/**
 * AES-256-GCM encryption for egc-memory .md state files.
 *
 * Files are encrypted with a random 12-byte IV prepended to the ciphertext.
 * A magic header ("EGC1:") is used to distinguish encrypted from plaintext
 * files so existing unencrypted state files continue to work (graceful
 * migration: read decrypts if magic present, writes always encrypt).
 *
 * The encryption key lives at ~/.egc/encryption.key (mode 0o600). It is
 * generated once with 32 bytes of crypto-random data and reused on
 * subsequent calls. Separate from the HMAC integrity key.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_DIR = path.join(os.homedir(), '.egc');
const ENC_KEY_PATH = path.join(KEY_DIR, 'encryption.key');
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAGIC = 'EGC1:';

/**
 * Load or create the AES-256-GCM encryption key at ~/.egc/encryption.key.
 * The key is 32 random bytes stored as hex (64 hex chars on disk).
 */
export function loadOrCreateEncKey(keyPath: string = ENC_KEY_PATH): Buffer {
  const dir = path.dirname(keyPath);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // directory may already exist
  }

  if (fs.existsSync(keyPath)) {
    try {
      const hex = fs.readFileSync(keyPath, 'utf-8').trim();
      if (hex.length === 64) return Buffer.from(hex, 'hex');
    } catch {
      // fall through to regenerate
    }
  }

  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyPath, key.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // best-effort: return key for this process lifetime
  }
  return key;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns a Buffer: MAGIC(5) + IV(12) + authTag(16) + ciphertext.
 */
export function encryptState(plaintext: string, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(MAGIC, 'utf-8'),
    iv,
    authTag,
    encrypted,
  ]);
}

/**
 * Decrypt a Buffer produced by encryptState().
 * Throws if authentication fails (tampered ciphertext).
 */
export function decryptState(data: Buffer, key: Buffer): string {
  const magicLen = Buffer.byteLength(MAGIC, 'utf-8');
  const iv = data.subarray(magicLen, magicLen + IV_BYTES);
  const authTag = data.subarray(magicLen + IV_BYTES, magicLen + IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = data.subarray(magicLen + IV_BYTES + AUTH_TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf-8');
}

/**
 * Returns true when the file content starts with the EGC1 magic header,
 * indicating it was encrypted by encryptState().
 */
export function isEncrypted(data: Buffer): boolean {
  return data.subarray(0, Buffer.byteLength(MAGIC, 'utf-8')).toString('utf-8') === MAGIC;
}

/**
 * Read a state file, decrypting if necessary. Returns plaintext string.
 * Falls back to raw UTF-8 for legacy unencrypted files.
 */
export function readStateFile(filePath: string, key: Buffer): string {
  const raw = fs.readFileSync(filePath);
  if (isEncrypted(raw)) {
    return decryptState(raw, key);
  }
  return raw.toString('utf-8');
}

/**
 * Write a state file, always encrypting.
 */
export function writeStateFile(filePath: string, plaintext: string, key: Buffer): void {
  const encrypted = encryptState(plaintext, key);
  fs.writeFileSync(filePath, encrypted);
  try { fs.chmodSync(filePath, 0o600); } catch { /* chmod not supported on Windows */ }
}
