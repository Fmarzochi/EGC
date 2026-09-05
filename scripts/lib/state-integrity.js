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

// Writes/refreshes the sidecar at `<stateFilePath>.hmac`. Best-effort: a
// sidecar write failure must never block the state write it accompanies.
function writeHmac(stateFilePath, content, key) {
  const hmacPath = `${stateFilePath}.hmac`;
  try {
    fs.writeFileSync(hmacPath, computeHmac(content, key), { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(hmacPath, 0o600);
  } catch { /* best-effort */ }
}

module.exports = {
  loadOrCreateIntegrityKey,
  computeHmac,
  writeHmac,
};
