'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getStateDir } = require('./branch-state');
const { MAGIC } = require('./state-crypto');

// State files have been encrypted at rest since 1.1.6 (EGC1 header). A
// plain-text file in the state directory either predates that, was written
// by the EGC hooks before 1.1.18 (they saved the compaction snapshot and the
// mined memory without encrypting), or was written straight to disk by an
// AI tool that had no egc-memory server registered and followed the old
// protocol text to the path (#1395). The scan only reads the first bytes:
// it never decrypts or loads a file.
const MAGIC_BYTES = Buffer.byteLength(MAGIC, 'utf-8');
const STATE_ARCHIVE_DIR = 'archive';
// Same open discipline as the key file in state-crypto.js: never through a
// link (a link swapped in after the listing gets ELOOP, not followed), never
// blocking (a planted FIFO cannot stall the caller), and only a regular file
// is inspected, all through the one descriptor the bytes are read from.
const NO_FOLLOW_FLAG = fs.constants.O_NOFOLLOW || 0;
const NON_BLOCKING_FLAG = fs.constants.O_NONBLOCK || 0;
const OPEN_FLAGS = fs.constants.O_RDONLY | NO_FOLLOW_FLAG | NON_BLOCKING_FLAG;

function readHeader(fd) {
  const head = Buffer.alloc(MAGIC_BYTES);
  const read = fs.readSync(fd, head, 0, MAGIC_BYTES, 0);
  return read === MAGIC_BYTES && head.toString('utf-8') === MAGIC;
}

// Whether the directory the descriptor was opened from still resolves
// inside the state directory. The listing filtered links, but a directory
// swapped for a link after the listing would have been followed by the
// open; resolving the real path of the parent at open time catches that.
function parentInsideRoot(filePath, root) {
  try {
    const parent = fs.realpathSync.native(path.dirname(filePath));
    return parent === root || parent.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

// Opens the path the way state-crypto.js opens the key: on a platform
// without O_NOFOLLOW a link is refused before the open and the descriptor
// is checked to be the same object afterwards (dev and inode), so a swap
// between the two cannot hand back a followed link.
function openCandidate(filePath) {
  const before = NO_FOLLOW_FLAG ? null : fs.lstatSync(filePath);
  if (before?.isSymbolicLink()) return null;
  const fd = fs.openSync(filePath, OPEN_FLAGS);
  if (before) {
    const after = fs.fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino) {
      fs.closeSync(fd);
      return null;
    }
  }
  return fd;
}

// Runs `use(fd, stat)` on a descriptor that is a regular file with plain
// content inside `root`, then closes it. Anything else (encrypted, not
// regular, empty, outside the state directory, cannot be opened here, which
// means nobody else on the machine can read it either) is null.
function withPlainCandidate(filePath, root, use) {
  let fd;
  try {
    fd = openCandidate(filePath);
    if (fd === null) return null;
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || !parentInsideRoot(filePath, root) || readHeader(fd)) return null;
    return use(fd, stat);
  } catch {
    return null;
  } finally {
    if (fd !== undefined && fd !== null) fs.closeSync(fd);
  }
}

// The finding for one listed path, or null when there is nothing to report.
function inspectStateFile(filePath, root) {
  return withPlainCandidate(filePath, root, (fd, stat) => ({
    path: filePath,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  }));
}

// The full plain content of one path, read through the same checked
// descriptor, or null when the file is no longer a plain regular file of
// the size it was opened at: a writer truncating it mid-read yields a short
// read, and a prefix is never treated as the whole state.
function readPlainStateFile(filePath, root) {
  return withPlainCandidate(filePath, root, (fd, stat) => {
    const content = Buffer.alloc(stat.size);
    const read = fs.readSync(fd, content, 0, stat.size, 0);
    if (read !== stat.size) return null;
    return content.toString('utf-8');
  });
}

function stillDirectory(dirPath) {
  try {
    return fs.lstatSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function listStateMarkdown(dirPath, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    // Links are never followed: a planted link must not pull in a file from
    // outside the state directory.
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(fullPath);
    // One level of project directories (<project-slug>/<branch>.md); the
    // archive folder holds consolidated copies and is not live state. The
    // entry is a snapshot, so the directory is checked again right before
    // it is read; the open-time parent check above covers the rest.
    if (entry.isDirectory() && depth > 0 && entry.name !== STATE_ARCHIVE_DIR && stillDirectory(fullPath)) {
      files.push(...listStateMarkdown(fullPath, depth - 1));
    }
  }
  return files;
}

// The real path of the state directory, or null when there is none: every
// candidate is checked against it at open time.
function stateRoot(stateDir) {
  try {
    return fs.realpathSync.native(stateDir);
  } catch {
    return null;
  }
}

function findPlaintextStateFiles(homeDir) {
  const stateDir = getStateDir(homeDir);
  const root = stateRoot(stateDir);
  const files = root ? listStateMarkdown(stateDir, 1) : [];
  const plaintext = files.map(filePath => inspectStateFile(filePath, root)).filter(Boolean);
  return { stateDir, root, checked: files.length, count: plaintext.length, files: plaintext };
}

module.exports = {
  findPlaintextStateFiles,
  inspectStateFile,
  readPlainStateFile,
  listStateMarkdown,
  stateRoot,
};
