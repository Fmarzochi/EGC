'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getStateDir } = require('./branch-state');
const { MAGIC, isEncryptedBuffer, decryptStateBuffer } = require('./state-crypto');

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
const NOT_PLAIN_CODES = new Set(['ENOENT', 'ELOOP', 'ENOTDIR']);

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
  } catch (error) {
    // Gone or turned into a link: not inside the root. Any other failure is
    // an I/O error the strict caller has to see, not a quiet skip.
    if (!NOT_PLAIN_CODES.has(error.code)) throw error;
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
  if (!before) return fd;
  // From here the descriptor is owned: a failing fstat must not leak it.
  let same;
  try {
    const after = fs.fstatSync(fd);
    same = after.dev === before.dev && after.ino === before.ino;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  if (same) return fd;
  fs.closeSync(fd);
  return null;
}

// Whether the open descriptor is the object that sits at the path right
// now, while the path's parent resolves inside `root`. The two checks are
// taken together so a directory swapped after the open cannot leave a
// descriptor pointing outside the state directory while the pathname
// still reads as inside it: the object behind the descriptor has to be
// the regular file at a path that is inside the root at this moment.
function descriptorAtPathInsideRoot(fd, stat, filePath, root) {
  if (!parentInsideRoot(filePath, root)) return false;
  try {
    const now = fs.lstatSync(filePath);
    return now.isFile() && now.dev === stat.dev && now.ino === stat.ino;
  } catch (error) {
    if (!NOT_PLAIN_CODES.has(error.code)) throw error;
    return false;
  }
}

// Runs `use(fd, stat)` on a descriptor that is a regular file with plain
// content inside `root`, then closes it. Anything else (encrypted, not
// regular, empty, outside the state directory) is null. A path that cannot
// be opened or read is null for a scan (nobody else on the machine can
// read it either, so it is not a finding) and an error for a strict
// caller, which must not report a plain file as handled when it was not.
function withPlainCandidate(filePath, root, use, { strict = false } = {}) {
  let fd;
  try {
    fd = openCandidate(filePath);
    if (fd === null) return null;
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || !descriptorAtPathInsideRoot(fd, stat, filePath, root) || readHeader(fd)) return null;
    return use(fd, stat);
  } catch (error) {
    // Gone, or a link now sits at the path: no longer a plain regular
    // file, which is a skip even for a strict caller. Anything else on an
    // existing file is a real I/O failure for that caller.
    if (strict && !NOT_PLAIN_CODES.has(error.code)) throw error;
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
// read, a writer growing it shows in a second fstat, and neither prefix is
// ever treated as the whole state. An I/O error is thrown, not swallowed.
function readPlainStateFile(filePath, root) {
  return withPlainCandidate(filePath, root, (fd, stat) => {
    const content = Buffer.alloc(stat.size);
    const read = fs.readSync(fd, content, 0, stat.size, 0);
    if (read !== stat.size || fs.fstatSync(fd).size !== stat.size) return null;
    // The path is checked once more after the read: a file swapped in
    // under the same name while this descriptor was open would otherwise
    // be overwritten with the stale content just read from the old one.
    if (!descriptorAtPathInsideRoot(fd, stat, filePath, root)) return null;
    return content.toString('utf-8');
  }, { strict: true });
}

function stillDirectory(dirPath) {
  try {
    return fs.lstatSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

// The whole content of a state file, plain or encrypted, read through the
// checked descriptor (never through a link, regular file, parent resolved
// into `root`), or null when the path is not a regular file inside the
// state directory, grew or shrank under the read, or no longer leads to
// the descriptor afterwards. An I/O error on an existing file is thrown.
function readStateFileBytes(filePath, root) {
  let fd;
  try {
    fd = openCandidate(filePath);
    if (fd === null) return null;
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !descriptorAtPathInsideRoot(fd, stat, filePath, root)) return null;
    const raw = Buffer.alloc(stat.size);
    const read = fs.readSync(fd, raw, 0, stat.size, 0);
    if (read !== stat.size || fs.fstatSync(fd).size !== stat.size) return null;
    if (!descriptorAtPathInsideRoot(fd, stat, filePath, root)) return null;
    return raw;
  } finally {
    if (fd !== undefined && fd !== null) fs.closeSync(fd);
  }
}

// The decrypted content of an encrypted state file read the same way, or
// null when the path is not an encrypted regular file inside the state
// directory or does not decrypt. Used to read a file back after it was
// written, so a swap after the write is not mistaken for it: the caller
// treats null as a failed read-back and restores.
function readEncryptedStateFile(filePath, root) {
  try {
    const raw = readStateFileBytes(filePath, root);
    if (raw === null || !isEncryptedBuffer(raw)) return null;
    return decryptStateBuffer(raw);
  } catch {
    return null;
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
  readEncryptedStateFile,
  readStateFileBytes,
  listStateMarkdown,
  stateRoot,
};
