'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isInsideReal, realizePath } = require('./path-safety');
const { replaceFileWith } = require('./install/preserving-write');

// A single read instead of existsSync() + readFileSync() closes the window
// where a concurrent process (an IDE, a cloud sync client) deletes or
// recreates the file between the two calls — existsSync() can say true and
// readFileSync() still throw ENOENT a moment later. Any other read error
// (permissions, a directory at that path) still propagates; only "genuinely
// absent" is treated as the same "start fresh" case as "never existed".
function readFileIfExists(targetPath) {
  try {
    return fs.readFileSync(targetPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// A config reached through a link is written where the link leads, which is
// how a dotfiles folder linked into place works, as long as that stays under
// one of roots (the home folder, the XDG config folder, a project's own
// folder). A link that leads anywhere else is left untouched, and nothing
// behind it is read either.
function assertLandsInside(targetPath, roots) {
  const landing = realizePath(targetPath);
  if (roots.some(root => isInsideReal(landing, root))) return;
  throw new Error(
    `${targetPath} leads through a link to ${landing}, outside ${roots.join(' and ')} - left untouched: ` +
    `keep the file under ${roots.join(' or ')} (move it or relink it), or add egc-guardian and egc-memory to it by hand`
  );
}

function isSymbolicLink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

// A config may carry credentials; one created here is readable by its owner
// only. An existing one keeps the mode its owner chose.
const NEW_CONFIG_MODE = 0o600;

// Run as root over another person's home, the replacement keeps the owner
// the file had, as a write in place did.
function ownerToKeep(filePath) {
  if (process.getuid?.() !== 0) return null;
  try {
    const { uid, gid } = fs.statSync(filePath);
    return { uid, gid };
  } catch {
    return null;
  }
}

// Where the folder or a mount refuses the replacement (a read-only folder
// holding a writable config, a config mounted on its own, a file another
// program holds on Windows), the config is written in place, as before.
const IN_PLACE_FALLBACK_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);

// A config its owner made read-only stays as it is, as the write in place
// left it; renaming over it would go around the file's own mode.
function assertWritableIfPresent(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function writeInPlace(filePath, text) {
  const descriptor = fs.openSync(filePath, 'w', NEW_CONFIG_MODE);
  try {
    fs.writeFileSync(descriptor, text);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

// The rename is recorded in the folder, so the folder is synced too.
function syncFolder(folder) {
  let descriptor;
  try {
    descriptor = fs.openSync(folder, 'r');
    fs.fsyncSync(descriptor);
  } catch {
    // Windows cannot open a folder and some filesystems refuse to sync one;
    // the replacement has landed either way.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

// Every config lands in one replacement where its path really leads, so a
// dotfiles link keeps pointing at the updated file: the text goes to a
// private temporary file beside it, reaches the disk, and is renamed over
// the previous file, so a write cut short leaves that file whole.
function writeConfig(targetPath, text) {
  const landing = realizePath(targetPath);
  assertWritableIfPresent(landing);
  const owner = ownerToKeep(landing);
  fs.mkdirSync(path.dirname(landing), { recursive: true });
  try {
    replaceFileWith(landing, (descriptor) => {
      fs.writeFileSync(descriptor, text);
      if (owner) fs.fchownSync(descriptor, owner.uid, owner.gid);
      fs.fsyncSync(descriptor);
    }, NEW_CONFIG_MODE);
  } catch (err) {
    if (!IN_PLACE_FALLBACK_CODES.has(err?.code)) throw err;
    writeInPlace(landing, text);
    return;
  }
  syncFolder(path.dirname(landing));
}

module.exports = {
  readFileIfExists,
  assertLandsInside,
  isSymbolicLink,
  writeConfig,
};
