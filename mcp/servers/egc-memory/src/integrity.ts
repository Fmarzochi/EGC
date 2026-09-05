/**
 * HMAC integrity checks for egc-memory state files.
 *
 * On every write: compute HMAC-SHA256 of the file content and store it in
 * a sidecar file (<statefile>.hmac) owned only by the current user.
 *
 * On every read: verify the sidecar HMAC against the file content and emit
 * a warning when they do not match (tamper detection). Reads still succeed
 * so a corrupted HMAC never hard-blocks the agent.
 *
 * The HMAC key lives at ~/.egc/integrity.key (mode 0o600). It is generated
 * once with 32 bytes of crypto-random data and reused on subsequent calls.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPrivateKeyFile, pathPresent, readPrivateKeyFile, writePrivateTemp } from './encryption.js';


const HMAC_ALGORITHM = 'sha256';

// Functions, not module-level constants: see the matching comment on
// defaultEncKeyPath() in encryption.ts — a frozen os.homedir() would keep
// resolving to whatever $HOME was in effect when this module first loaded,
// diverging from getStateDir() (index.ts) if the process later observes a
// different $HOME.
function keyDir(): string {
  return path.join(os.homedir(), '.egc');
}

function keyPath(): string {
  return path.join(keyDir(), 'integrity.key');
}

/**
 * Load or create the HMAC key at ~/.egc/integrity.key.
 * The key is 32 random bytes encoded as hex (64 hex chars on disk).
 */
export function loadOrCreateKey(): Buffer {
  const KEY_DIR = keyDir();
  const KEY_PATH = keyPath();
  try {
    fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // directory may already exist
  }

  const readExistingKey = (): Buffer => {
    // Read from the descriptor the private-file checks ran on: a link, a
    // non-regular object, a wide mode or an unreadable file is refused
    // there with its own message.
    const hex = readPrivateKeyFile(KEY_PATH).trim();


    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(
        `HMAC key file at ${KEY_PATH} is malformed (expected 64 hex characters). ` +
        `Remove it to regenerate: rm "${KEY_PATH}"`
      );
    }

    const key = Buffer.from(hex, 'hex');
    try { fs.chmodSync(KEY_DIR, 0o700); } catch { /* best-effort */ }
    return key;
  };

  if (pathPresent(KEY_PATH)) return readExistingKey();

  // Generate a fresh key and publish it the way the encryption key is
  // published: written whole to a private temp file, then linked into place
  // exclusively, so a concurrent creator never reads a truncated key and
  // the loser of the race adopts the key that landed instead of signing
  // with one that is not on disk. A key that cannot be persisted or kept
  // private is not used: every state file signed with it would fail
  // verification on the next start, and a key on disk with wide
  // permissions would let another user forge the signatures.
  const key = crypto.randomBytes(32);
  const tmpPath = `${KEY_PATH}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let published: boolean;
  try {
    writePrivateTemp(tmpPath, key.toString('hex'));

    published = linkExclusively(tmpPath, KEY_PATH);
  } catch (e) {
    throw new Error(`[EGC integrity] Failed to persist HMAC key to ${KEY_PATH}: ${String(e)}. Fix the directory permissions and restart.`, { cause: e });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* already linked or never written */ }
  }
  if (!published) return readExistingKey();
  assertPrivateKeyFile(KEY_PATH);
  return key;
}

// True when `target` was created by this call; false when another process
// published it first.
function linkExclusively(source: string, target: string): boolean {
  try {
    fs.linkSync(source, target);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * Compute HMAC-SHA256 of `content` using the provided key.
 */
export function computeHmac(content: string, key: Buffer): string {
  return crypto.createHmac(HMAC_ALGORITHM, key).update(content, 'utf-8').digest('hex');
}

/**
 * Write a sidecar HMAC file next to `stateFilePath`.
 * The sidecar is stored at `<stateFilePath>.hmac` (mode 0o600).
 */
export function writeHmac(stateFilePath: string, content: string, key: Buffer): void {
  const hmacPath = `${stateFilePath}.hmac`;
  const hmac = computeHmac(content, key);
  try {
    fs.writeFileSync(hmacPath, hmac, { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(hmacPath, 0o600);
  } catch {
    // best-effort: integrity sidecar failure must never block state writes
  }
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_sidecar' | 'hmac_mismatch' | 'read_error' };

/**
 * Verify the sidecar HMAC for `stateFilePath` against `content`.
 *
 * Returns `{ ok: true }` when the file is intact.
 * Returns `{ ok: false, reason }` when tamper detection fires or the
 * sidecar is absent — callers should warn but MUST NOT hard-block reads.
 */
export function verifyHmac(
  stateFilePath: string,
  content: string,
  key: Buffer,
): VerifyResult {
  const hmacPath = `${stateFilePath}.hmac`;

  if (!fs.existsSync(hmacPath)) {
    return { ok: false, reason: 'missing_sidecar' };
  }

  let storedHmac: string;
  try {
    storedHmac = fs.readFileSync(hmacPath, 'utf-8').trim();
  } catch {
    return { ok: false, reason: 'read_error' };
  }

  if (storedHmac.length !== 64 || !/^[0-9a-f]{64}$/.test(storedHmac)) {
    return { ok: false, reason: 'hmac_mismatch' };
  }
  const expected = computeHmac(content, key);
  const storedBuf = Buffer.from(storedHmac, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const match = crypto.timingSafeEqual(storedBuf, expectedBuf);
  return match ? { ok: true } : { ok: false, reason: 'hmac_mismatch' };
}
