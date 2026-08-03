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

const HMAC_ALGORITHM = 'sha256';

function keyDir() {
  return path.join(os.homedir(), '.egc');
}

function keyPath() {
  return path.join(keyDir(), 'integrity.key');
}

// Mirrors loadOrCreateKey() in integrity.ts, including its "never silently
// regenerate an existing key" rule.
function loadOrCreateIntegrityKey() {
  const KEY_DIR = keyDir();
  const KEY_PATH = keyPath();
  try {
    fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  } catch { /* directory may already exist */ }

  if (fs.existsSync(KEY_PATH)) {
    const hex = fs.readFileSync(KEY_PATH, 'utf-8').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(
        `HMAC key file at ${KEY_PATH} is malformed (expected 64 hex characters). ` +
        `Remove it to regenerate: rm "${KEY_PATH}"`
      );
    }
    const key = Buffer.from(hex, 'hex');
    try { fs.chmodSync(KEY_PATH, 0o600); } catch { /* best-effort */ }
    try { fs.chmodSync(KEY_DIR, 0o700); } catch { /* best-effort */ }
    return key;
  }

  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(KEY_PATH, key.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(KEY_PATH, 0o600);
  } catch { /* best-effort: integrity sidecar failure must never block state writes */ }
  return key;
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
