'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const COPY_CHUNK_BYTES = 64 * 1024;

// Files the installer and its repair replay manage land in one atomic
// replacement: the content is written to a temporary sibling that is created
// exclusively (a link planted at that name is refused, never followed), with
// its final mode from the start, and renamed over the destination, so a hard
// link or a symlink at the destination is replaced instead of written
// through, and nothing outside the managed location is modified. An existing
// destination keeps the mode its owner chose; a new one takes `createMode`.
function replaceFileWith(destinationPath, writeContent, createMode = 0o644) {
  let existingMode;
  try {
    existingMode = fs.statSync(destinationPath).mode & 0o777;
  } catch {
    existingMode = null;
  }
  const mode = existingMode ?? createMode;
  const temporary = `${destinationPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', mode);
  let open = true;
  try {
    writeContent(descriptor);
    fs.fchmodSync(descriptor, mode);
    fs.closeSync(descriptor);
    open = false;
    fs.renameSync(temporary, destinationPath);
  } catch (error) {
    if (open) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // the descriptor is gone already
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // nothing was left to remove
    }
    throw error;
  }
}

function copyThroughDescriptor(sourcePath, descriptor) {
  const source = fs.openSync(sourcePath, 'r');
  try {
    const buffer = Buffer.alloc(COPY_CHUNK_BYTES);
    for (;;) {
      const read = fs.readSync(source, buffer, 0, buffer.length, null);
      if (read === 0) break;
      let offset = 0;
      while (offset < read) {
        const written = fs.writeSync(descriptor, buffer, offset, read - offset);
        if (written <= 0) throw new Error(`Short write while copying ${sourcePath}`);
        offset += written;
      }

    }
  } finally {
    fs.closeSync(source);
  }
}

// A destination created here takes the source's permission bits.
function copyFileKeepingMode(sourcePath, destinationPath) {
  const sourceMode = fs.statSync(sourcePath).mode & 0o777;
  replaceFileWith(destinationPath, descriptor => copyThroughDescriptor(sourcePath, descriptor), sourceMode);
}

module.exports = { copyFileKeepingMode, replaceFileWith };
