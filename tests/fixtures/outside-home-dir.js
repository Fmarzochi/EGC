'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A fresh writable directory outside the home and the temp directory, where
// a checkout of a person may live (/var/tmp, /opt, /srv, another drive), or
// null when this machine offers none, so the case that needs one is skipped
// instead of failing. The caller removes the directory it gets.
function outsideHomeAndTemp() {
  const inside = (p, root) => p === root || p.startsWith(root + path.sep);
  const home = fs.realpathSync.native(os.homedir());
  const temp = fs.realpathSync.native(os.tmpdir());
  const candidates = process.platform === 'win32'
    ? [path.join(path.parse(process.cwd()).root, 'egc-outside'), path.join(path.parse(home).root, 'egc-outside')]
    : ['/var/tmp/egc-outside', '/opt/egc-outside', '/srv/egc-outside'];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const real = fs.realpathSync.native(candidate);
      if (!inside(real, home) && !inside(real, temp)) return fs.mkdtempSync(path.join(candidate, 'run-'));
    } catch {
      // Not writable here: the next candidate.
    }
  }
  return null;
}

// Removes the directory outsideHomeAndTemp gave and its parent when empty.
function removeOutside(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.rmdirSync(path.dirname(dir));
  } catch {
    // Another run still owns the parent.
  }
}

module.exports = { outsideHomeAndTemp, removeOutside };
