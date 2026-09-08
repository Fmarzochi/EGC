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

// Runs `use(fd, stat)` on a descriptor that is a regular file with plain
// content, then closes it. Anything else (encrypted, not regular, empty,
// cannot be opened here, which means nobody else on the machine can read
// it either) is null.
function withPlainCandidate(filePath, use) {
  let fd;
  try {
    fd = fs.openSync(filePath, OPEN_FLAGS);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || readHeader(fd)) return null;
    return use(fd, stat);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The finding for one listed path, or null when there is nothing to report.
function inspectStateFile(filePath) {
  return withPlainCandidate(filePath, (fd, stat) => ({
    path: filePath,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  }));
}

// The full plain content of one path, read through the same checked
// descriptor, or null when the file is no longer a plain regular file.
function readPlainStateFile(filePath) {
  return withPlainCandidate(filePath, (fd, stat) => {
    const content = Buffer.alloc(stat.size);
    const read = fs.readSync(fd, content, 0, stat.size, 0);
    return content.subarray(0, read).toString('utf-8');
  });
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
    // archive folder holds consolidated copies and is not live state.
    if (entry.isDirectory() && depth > 0 && entry.name !== STATE_ARCHIVE_DIR) {
      files.push(...listStateMarkdown(fullPath, depth - 1));
    }
  }
  return files;
}

function findPlaintextStateFiles(homeDir) {
  const stateDir = getStateDir(homeDir);
  const files = listStateMarkdown(stateDir, 1);
  const plaintext = files.map(inspectStateFile).filter(Boolean);
  return { stateDir, checked: files.length, count: plaintext.length, files: plaintext };
}

module.exports = {
  findPlaintextStateFiles,
  inspectStateFile,
  readPlainStateFile,
  listStateMarkdown,
};
