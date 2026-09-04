'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

// Files the installer and its repair replay manage land in one atomic
// replacement: the content is written to a temporary sibling that is created
// exclusively (a link planted at that name is refused, never followed) and
// renamed over the destination, so a hard link or a symlink at the
// destination is replaced instead of written through, and nothing outside
// the managed location is modified. An existing destination keeps the mode
// its owner chose.
function replaceFileWith(destinationPath, writeContent) {
  let existingMode;
  try {
    existingMode = fs.statSync(destinationPath).mode & 0o777;
  } catch {
    existingMode = null;
  }
  const temporary = `${destinationPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', existingMode ?? 0o644);
  let open = true;
  try {
    writeContent(descriptor);
    if (existingMode !== null) fs.fchmodSync(descriptor, existingMode);
    open = false;
    fs.closeSync(descriptor);
    fs.renameSync(temporary, destinationPath);
  } catch (error) {
    if (open) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // nothing was left to remove
    }
    throw error;
  }
}

// A destination created here takes the source's permission bits.
function copyFileKeepingMode(sourcePath, destinationPath) {
  const sourceMode = fs.statSync(sourcePath).mode & 0o777;
  const existed = fs.existsSync(destinationPath);
  replaceFileWith(destinationPath, descriptor => {
    fs.writeFileSync(descriptor, fs.readFileSync(sourcePath));
    if (!existed) fs.fchmodSync(descriptor, sourceMode);
  });
}

module.exports = { copyFileKeepingMode, replaceFileWith };
