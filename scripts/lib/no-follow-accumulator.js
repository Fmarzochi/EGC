'use strict';

// Shared no-follow file access for the edited-files accumulator
// (post-edit-accumulator.js writes it, stop-format-typecheck.js reads it).
// Lifted out after cubic flagged the open/read-without-following-a-symlink
// discipline as defined a third time, nearly identically, alongside
// readFileNoFollow in scripts/lib/branch-state.js.
//
// O_NOFOLLOW is unsupported on Windows (libuv's UV_FS_O_NOFOLLOW docs say
// so explicitly), so NOFOLLOW_FLAG is 0 there and every open below falls
// back to an lstatSync check immediately before the open -- a narrower
// TOCTOU window than no check at all, not a hermetic close of it: Node has
// no portable openat() to anchor an open to an already-validated directory
// fd.

const fs = require('node:fs');

const NOFOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
const NONBLOCK_FLAG = typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0;

function isSymlink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// Every byte of `data` written to fd, a short write resumed, zero progress
// thrown on: the same discipline writeAllBytes in scripts/lib/state-crypto.js
// and copyThroughDescriptor in scripts/lib/install/preserving-write.js use,
// so a partial write is never silently accepted as done.
function writeAllBytesSync(fd, data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error('[EGC] short write: no progress while writing the accumulator');
    offset += written;
  }
}

// Reads filePath without following a symlink at its final component, and
// without reading through a non-regular object (a FIFO or device node
// planted at the path, which open() can otherwise block on or stream from
// forever). Returns null on any failure -- missing, a symlink, not a
// regular file, an I/O error -- so callers treat every "cannot read
// safely" case alike, never surfacing partial or unsafe content.
function readFileNoFollow(filePath) {
  let fd;
  try {
    if (NOFOLLOW_FLAG === 0 && isSymlink(filePath)) return null;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG);
    if (!fs.fstatSync(fd).isFile()) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Appends `line` to filePath, refusing a symlinked final component and
// refusing a file this process does not own, so a file pre-planted by
// another user (no O_CREAT race to win, since planting an ordinary file
// ahead of time needs no symlink at all) is never written through. A
// planted FIFO opened for writing blocks until a reader shows up, which
// NONBLOCK_FLAG turns into an immediate ENXIO instead -- the same reason
// readFileNoFollow carries it -- so this call never hangs the post-edit
// hook (cubic review, confidence 10). Mode 0600 is enforced on every
// call, not only the one that creates the file, so a file left over from
// an older version of this code, with a wider mode, is tightened rather
// than trusted. Returns true on success, false on any refusal or
// failure -- this accumulator is best-effort, so a caller never has to
// distinguish "symlinked" from "permission denied" from "disk full".
function appendLineNoFollow(filePath, line) {
  let fd;
  try {
    if (NOFOLLOW_FLAG === 0 && isSymlink(filePath)) return false;
    fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW_FLAG | NONBLOCK_FLAG, 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return false;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false;
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);
    writeAllBytesSync(fd, line);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { readFileNoFollow, appendLineNoFollow, writeAllBytesSync, NOFOLLOW_FLAG };
