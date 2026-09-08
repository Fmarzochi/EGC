'use strict';

// HMAC integrity for egc-memory state files, mirroring
// mcp/servers/egc-memory/src/integrity.ts (JS mirror pattern also used by
// state-crypto.js in this directory -- keep both in sync). Every writer that
// touches a state file directly (the MCP server's update_state, and the
// direct-write hooks in this directory: state-snapshot.js, consolidate.js)
// must refresh the <statefile>.hmac sidecar, or the next get_state reports a
// false-positive tamper warning for a file nothing actually tampered with.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadOrCreateKeySync } = require('./state-crypto');

const HMAC_ALGORITHM = 'sha256';

function keyPath() {
  return path.join(os.homedir(), '.egc', 'integrity.key');
}

// state-crypto.js's loadOrCreateKeySync() is already a general 32-byte
// hex-key-file load-or-create (atomic write-tmp-then-link) -- reused here
// with the integrity key's own path instead of re-implementing the same
// routine a second time. Its failures are as fatal here as they are for
// the encryption key: a key that cannot be persisted would sign sidecars
// that fail verification on the next start, and a key that cannot be kept
// private would let another local user forge them, so neither is used.
function loadOrCreateIntegrityKey() {
  return loadOrCreateKeySync(keyPath());
}

function computeHmac(content, key) {
  return crypto.createHmac(HMAC_ALGORITHM, key).update(content, 'utf-8').digest('hex');
}

function hmacPathFor(stateFilePath) {
  return `${stateFilePath}.hmac`;
}

// Writes/refreshes the sidecar at `<stateFilePath>.hmac`. Best-effort for
// the hooks (a sidecar failure must never block the state write it
// accompanies), so the outcome is returned rather than thrown; a caller
// that needs the sidecar checks the boolean. The bytes land in a fresh
// exclusive temp file and are renamed over the sidecar path: rename
// replaces whatever sits there, a planted link included, and never writes
// through it.
function writeHmac(stateFilePath, content, key) {
  const hmacPath = hmacPathFor(stateFilePath);
  // Named independently of the state basename: a long branch file plus the
  // sidecar suffix fits the filesystem's component limit, and the temp name
  // must not be the one that does not.
  const tmpPath = path.join(path.dirname(hmacPath), `.egc-hmac-tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(tmpPath, computeHmac(content, key), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(tmpPath, 0o600); } catch { /* no POSIX bits on this filesystem */ }
    fs.renameSync(tmpPath, hmacPath);
    return true;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* never created, or already renamed */ }
    return false;
  }
}

const NO_FOLLOW_FLAG = fs.constants.O_NOFOLLOW || 0;
const NON_BLOCKING_FLAG = fs.constants.O_NONBLOCK || 0;

// Reads a small regular file through a descriptor that never followed a
// link and is checked to be the object that was at the path (same
// discipline as the key file in state-crypto.js), or null. Without
// O_NOFOLLOW the link check happens before the open and the identity check
// after it; with it the open itself refuses a link.
function readRegularNoFollow(filePath) {
  let fd;
  try {
    const before = NO_FOLLOW_FLAG ? null : fs.lstatSync(filePath);
    if (before?.isSymbolicLink()) return null;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW_FLAG | NON_BLOCKING_FLAG);
    const after = fs.fstatSync(fd);
    if (!after.isFile()) return null;
    if (before && (after.dev !== before.dev || after.ino !== before.ino)) return null;
    return fs.readFileSync(fd, 'utf-8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Whether the sidecar on disk is a regular file carrying the HMAC of
// `content`. A link at the sidecar path is never a valid sidecar.
function sidecarMatches(stateFilePath, content, key) {
  const digest = readRegularNoFollow(hmacPathFor(stateFilePath));
  return digest !== null && digest.trim() === computeHmac(content, key);
}

module.exports = {
  loadOrCreateIntegrityKey,
  computeHmac,
  writeHmac,
  sidecarMatches,
  hmacPathFor,
};
