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

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAGIC = 'EGC1:';

// A function, not a module-level constant: os.homedir() must be read fresh
// on every call. A frozen constant would keep resolving to whatever $HOME
// was in effect when this module first loaded, even if the MCP server
// process later observes a different $HOME — silently diverging from
// getStateDir() (index.ts), which already recomputes os.homedir() per call.
// That divergence is what let a state file get encrypted under one key and
// later fail decryption under another, long after the key file itself had
// stopped changing.
function defaultEncKeyPath(): string {
  return path.join(os.homedir(), '.egc', 'encryption.key');
}

/**
 * Load or create the AES-256-GCM encryption key at ~/.egc/encryption.key.
 * The key is 32 random bytes stored as hex (64 hex chars on disk).
 * Throws if the key file exists but cannot be read or is malformed —
 * only generates a new key when the file genuinely does not exist.
 */
// A key file must be private and must be the file itself. It is opened
// without following links (O_NOFOLLOW where the platform has it, with an
// identity check across the open where it does not) and without blocking
// (so a FIFO planted at the path cannot stall the open), and every check
// runs on that one descriptor: the object must be a regular file, the
// mode is set and read back through the descriptor, and the content is
// read from it, so the file that was checked is the file that is used and
// a path swapped underneath the checks changes nothing. Where the
// filesystem keeps POSIX bits (Linux, macOS, most network mounts) a file
// still readable by the group or others after the chmod is a hard error,
// because the key would sit exposed with nothing but a log line to say so,
// and a mount that cannot hold 0600 at all (FAT, exFAT) is refused with
// the advice to move the key. Windows has no bits to tighten, so the mode
// step is skipped there.
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = fs.constants.O_NONBLOCK ?? 0;

function linkRefusal(filePath: string, cause?: unknown): Error {
  return new Error(`[EGC] ${filePath} is a symbolic link; the key must be a regular file. Replace the link and restart.`, { cause });
}

// Without O_NOFOLLOW the link check happens before the open, so the object
// that was opened must be the object that was checked: same device, same
// inode. Anything else was swapped underneath and is refused.
function sameObject(before: fs.Stats, fd: number): boolean {
  const after = fs.fstatSync(fd);
  return after.dev === before.dev && after.ino === before.ino;
}

function openPrivateKeyFile(filePath: string): number {
  let before: fs.Stats | null = null;
  if (NO_FOLLOW === 0) {
    before = fs.lstatSync(filePath);
    if (before.isSymbolicLink()) throw linkRefusal(filePath);
  }
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
  } catch (openErr) {
    const code = (openErr as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw linkRefusal(filePath, openErr);
    const error: NodeJS.ErrnoException = new Error(`[EGC] Could not open ${filePath}: ${(openErr as Error).message}. The key file must exist and be a regular file.`, { cause: openErr });
    error.code = code;
    throw error;
  }
  try {
    if (before !== null && !sameObject(before, fd)) {
      throw new Error(`[EGC] ${filePath} changed while it was being opened; the key must be a regular file that stays put. Check for a link planted at the path and restart.`);
    }
    checkPrivateDescriptor(fd, filePath);
  } catch (checkErr) {
    fs.closeSync(fd);
    throw checkErr;
  }
  return fd;
}

function checkPrivateDescriptor(fd: number, filePath: string): void {
  if (!fs.fstatSync(fd).isFile()) {
    throw new Error(`[EGC] ${filePath} is not a regular file; the key must be a regular file. Replace it and restart.`);
  }
  if (process.platform === 'win32') return;
  try {
    fs.fchmodSync(fd, 0o600);
  } catch (chmodErr) {
    throw new Error(`[EGC] Could not set 0600 permissions on ${filePath}: ${(chmodErr as Error).message}. The key must not be readable by other users; fix the permissions and restart.`, { cause: chmodErr });
  }
  const mode = fs.fstatSync(fd).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`[EGC] ${filePath} is readable by other users (mode ${mode.toString(8)}) and the filesystem did not accept 0600. Move the key to a filesystem with POSIX permissions.`);
  }
}

export function assertPrivateKeyFile(filePath: string): void {
  fs.closeSync(openPrivateKeyFile(filePath));
}

// The content of a key file, read from the descriptor the checks ran on.
export function readPrivateKeyFile(filePath: string): string {
  const fd = openPrivateKeyFile(filePath);
  try {
    return fs.readFileSync(fd, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

// Whether anything (a file, a link, even a dangling one) sits at the path:
// a dangling link must be refused as a link, never treated as absent and
// replaced. Only a path with nothing at it is absent; a path that cannot
// be inspected is an error, never a silent absence.
export function pathPresent(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw new Error(`[EGC] Could not inspect ${filePath}: ${(err as Error).message}`, { cause: err });
  }
}

// Every byte of `bytes` written to `fd`: a short write continues from where
// it stopped, and no progress at all is an error, so a file is never
// published half written.
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('[EGC] short write: no progress while writing the key file');
    offset += written;
  }
}

// The temp file is created exclusively (wx): a link planted at the temp
// path is never followed, so the key is written only into a file this call
// created, private from the first byte and complete before it is published.
export function writePrivateTemp(tmpPath: string, content: string): void {
  const fd = fs.openSync(tmpPath, 'wx', 0o600);
  try {
    writeAll(fd, Buffer.from(content, 'utf-8'));
  } finally {
    fs.closeSync(fd);
  }
}

export function loadOrCreateEncKey(keyPath: string = defaultEncKeyPath()): Buffer {
  const dir = path.dirname(keyPath);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best-effort */ }
  } catch {
    // directory may already exist
  }

  const readExistingKey = (): Buffer => {
    const hex = readPrivateKeyFile(keyPath).trim();

    const key = Buffer.from(hex, 'hex');
    if (key.length !== 32) {
      throw new Error(`[EGC encryption] Key file at ${keyPath} is malformed (expected 32 bytes, got ${key.length}). Remove it to regenerate.`);
    }
    return key;
  };

  if (pathPresent(keyPath)) {
    // Key file exists — load it. Do NOT silently regenerate on error;
    // that would destroy access to all previously encrypted state files.
    return readExistingKey();
  }

  try { fs.chmodSync(dir, 0o700); } catch { /* best-effort */ }

  // Key file does not exist — generate a fresh one. A concurrent process
  // (e.g. a background agent's own egc-memory process starting up before
  // ~/.egc/encryption.key exists) may be racing to create the same key.
  // Writing directly to keyPath with an exclusive flag would leave a window
  // where the file exists but is only partially written, so a racing reader
  // could observe a truncated key. Instead, write the full key to a
  // uniquely-named temp file first, then publish it with an exclusive
  // fs.linkSync: the target only ever appears once fully written, and
  // linkSync fails with EEXIST (without touching the target) if another
  // process already published its key first — in which case we discard our
  // own key and read back whichever one actually landed on disk.
  const key = crypto.randomBytes(32);
  const tmpPath = `${keyPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    writePrivateTemp(tmpPath, key.toString('hex'));

    try {
      fs.linkSync(tmpPath, keyPath);
      assertPrivateKeyFile(keyPath);
      return key;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        return readExistingKey();
      }
      throw new Error(`[EGC encryption] Failed to persist encryption key to ${keyPath}: ${String(e)}. Remove the file or fix permissions and restart.`, { cause: e });
    }
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
  }
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
  return decipher.update(ciphertext, undefined, 'utf-8') + decipher.final('utf-8');
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
 * Write a state file atomically, always encrypting.
 * Writes to a temp file then renames to prevent partial-write corruption.
 */
export function writeStateFile(filePath: string, plaintext: string, key: Buffer): void {
  const encrypted = encryptState(plaintext, key);
  // Unique per call, not just per file: a fixed `${filePath}.tmp` name lets
  // two concurrent writers to the same state file (different processes, or
  // a lock timeout letting a second write through) overwrite each other's
  // temp file before either renames, producing ciphertext with bytes from
  // both writes — undecryptable garbage that looks like corruption. A
  // randomUUID (122 bits of entropy) makes a same-process collision
  // practically impossible even under heavy concurrency; a 32-bit suffix
  // (crypto.randomBytes(4)) does not carry the same guarantee.
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmpPath, encrypted);
    try { fs.chmodSync(tmpPath, 0o600); } catch { /* chmod not supported on Windows */ }
    fs.renameSync(tmpPath, filePath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* already renamed away; best-effort cleanup */ }
  }
}

/**
 * Move a state file that can no longer be decrypted (corrupted, or
 * encrypted with a key that no longer matches ~/.egc/encryption.key) out
 * of the way so a caller can start writing fresh state in its place.
 * Renames rather than deletes: the corrupted bytes are preserved at a
 * sibling '.corrupted-backup-<timestamp>' path in case they turn out to
 * be recoverable some other way. Returns the backup path.
 */
export function quarantineUndecryptableStateFile(filePath: string): string {
  const backupPath = `${filePath}.corrupted-backup-${Date.now()}`;
  fs.renameSync(filePath, backupPath);
  return backupPath;
}
