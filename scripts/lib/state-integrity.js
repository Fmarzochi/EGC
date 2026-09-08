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
  const tmpPath = `${hmacPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
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

// Whether the sidecar on disk is a regular file carrying the HMAC of
// `content`. Read without following a link: a link at the sidecar path is
// never a valid sidecar.
function sidecarMatches(stateFilePath, content, key) {
  const hmacPath = hmacPathFor(stateFilePath);
  try {
    if (!fs.lstatSync(hmacPath).isFile()) return false;
    return fs.readFileSync(hmacPath, 'utf-8').trim() === computeHmac(content, key);
  } catch {
    return false;
  }
}

module.exports = {
  loadOrCreateIntegrityKey,
  computeHmac,
  writeHmac,
  sidecarMatches,
  hmacPathFor,
};
