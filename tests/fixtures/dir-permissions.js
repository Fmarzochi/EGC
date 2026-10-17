'use strict';

const fs = require('node:fs');

// chmod-based cases need a filesystem that enforces directory permission
// bits for the current user: not Windows, and not root.
function permissionBitsEnforced() {
  if (process.platform === 'win32') return false;
  return !(typeof process.getuid === 'function' && process.getuid() === 0);
}

// Runs fn with the throwaway directory set to `mode` (0o555 for read-only,
// 0o000 for no access), then gives it back to its owner, who is the only one
// that goes on using it and removes it.
async function withDirMode(dir, mode, fn) {
  fs.chmodSync(dir, mode);
  try {
    return await fn();
  } finally {
    fs.chmodSync(dir, 0o700);
  }
}

module.exports = { permissionBitsEnforced, withDirMode };
