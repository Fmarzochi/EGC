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

// A key file must be private and must be the file itself: it is opened
// without following links (O_NOFOLLOW where the platform has it, with an
// identity check across the open where it does not) and without blocking
// (a FIFO planted at the path cannot stall the open), the object behind
// the descriptor must be a regular file, the mode is set and read back
// through that descriptor, and the content is read from it, so the file
// that was checked is the file that is used. Where the filesystem keeps
// POSIX bits a file still readable by others after the chmod is a hard
// error; on Windows there are no bits to tighten, so the mode step is
// skipped there.
const NO_FOLLOW_FLAG = fs.constants.O_NOFOLLOW || 0;
const NON_BLOCKING_FLAG = fs.constants.O_NONBLOCK || 0;

function linkRefusal(filePath, cause) {
  return new Error(`[EGC] ${filePath} is a symbolic link; the key must be a regular file. Replace the link and restart.`, { cause });
}

function keyDescriptor(filePath) {
  const before = NO_FOLLOW_FLAG ? null : fs.lstatSync(filePath);
  if (before?.isSymbolicLink()) throw linkRefusal(filePath, null);
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW_FLAG | NON_BLOCKING_FLAG);
  } catch (openErr) {
    if (openErr.code === 'ELOOP') throw linkRefusal(filePath, openErr);
    const error = new Error(`[EGC] Could not open ${filePath}: ${openErr.message}. The key file must exist and be a regular file.`, { cause: openErr });
    error.code = openErr.code;
    throw error;
  }
  if (before) {
    let swapped;
    try {
      const after = fs.fstatSync(fd);
      swapped = after.dev !== before.dev || after.ino !== before.ino;
    } catch (statErr) {
      fs.closeSync(fd);
      throw statErr;
    }
    if (swapped) {
      fs.closeSync(fd);
      throw new Error(`[EGC] ${filePath} changed while it was being opened; the key must be a regular file that stays put. Check for a link planted at the path and restart.`);
    }
  }
  return fd;
}

function refuseUnlessRegularAndPrivate(fd, filePath) {
  if (!fs.fstatSync(fd).isFile()) {
    throw new Error(`[EGC] ${filePath} is not a regular file; the key must be a regular file. Replace it and restart.`);
  }
  if (process.platform === 'win32') return;
  let failure = null;
  try { fs.fchmodSync(fd, 0o600); } catch (chmodErr) { failure = chmodErr; }
  if (failure) {
    throw new Error(`[EGC] Could not set 0600 permissions on ${filePath}: ${failure.message}. The key must not be readable by other users; fix the permissions and restart.`, { cause: failure });
  }
  const bits = fs.fstatSync(fd).mode & 0o777;
  if (bits & 0o077) {
    throw new Error(`[EGC] ${filePath} is readable by other users (mode ${bits.toString(8)}) and the filesystem did not accept 0600. Move the key to a filesystem with POSIX permissions.`);
  }
}

// Runs `use(fd)` on the checked descriptor of the key file, then closes it.
function withPrivateKeyFile(filePath, use) {
  const fd = keyDescriptor(filePath);
  try {
    refuseUnlessRegularAndPrivate(fd, filePath);
    return use(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function assertPrivateKeyFile(filePath) {
  withPrivateKeyFile(filePath, () => undefined);
}

// Whether anything (a file, a link, even a dangling one) sits at the path.
// Only a path with nothing at it (ENOENT) is absent; a path that cannot be
// inspected, a parent that is not a directory included, is an error, never
// a silent absence.
function present(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;

    throw new Error(`[EGC] Could not inspect ${filePath}: ${err.message}`, { cause: err });
  }
}

// Every byte written, a short write resumed, no progress refused: a key
// file is never published half written.
function writeAllBytes(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('[EGC] short write: no progress while writing the key file');
    offset += written;
  }
}

// The key at `keyPath`, or null when nothing sits at the path or the file
// is malformed. Every read goes through the checks on the descriptor it
// reads from, and any refusal (a link, a wide mode, a non-regular object,
// an unreadable file) is an error, never a silent null.
function loadKey(keyPath) {
  const resolvedPath = keyPath || defaultKeyPath();
  if (!present(resolvedPath)) return null;
  const hex = withPrivateKeyFile(resolvedPath, fd => fs.readFileSync(fd, 'utf-8')).trim();
  const key = Buffer.from(hex, 'hex');
  return key.length === 32 ? key : null;
}

// Mirrors loadOrCreateEncKey() in encryption.ts: same atomic
// write-tmp-then-link publish so a concurrent creator (the MCP server, or
// another hook invocation) can never observe a truncated key, and the same
// "never silently regenerate an existing key" safety rule. Only the create
// path is new here -- reads still go through loadKey() elsewhere in this file.
function loadOrCreateKeySync(keyPath) {
  const resolvedPath = keyPath || defaultKeyPath();
  const dir = path.dirname(resolvedPath);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* may already exist */ }

  if (present(resolvedPath)) {
    return loadKey(resolvedPath);
  }

  const key = crypto.randomBytes(32);
  const tmpPath = `${resolvedPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    // Created exclusively (wx): a link planted at the temp path is never
    // followed, so the key lands only in a file this call created.
    const tmpFd = fs.openSync(tmpPath, 'wx', 0o600);
    try { writeAllBytes(tmpFd, Buffer.from(key.toString('hex'), 'utf-8')); } finally { fs.closeSync(tmpFd); }


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
  // A missing or malformed key resolves to null; a key that cannot be kept
  // private is an error that reaches the caller.
  const key = loadKey(keyPath);
  if (!key) return null;
  try {
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
