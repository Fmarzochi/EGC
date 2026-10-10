'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function resolveWriteTarget(filepath) {
  let stat;
  try {
    stat = fs.lstatSync(filepath);
  } catch {
    return filepath;
  }
  if (!stat.isSymbolicLink()) return filepath;
  try {
    return fs.realpathSync(filepath);
  } catch {
    return path.resolve(path.dirname(filepath), fs.readlinkSync(filepath));
  }
}

function closeQuietly(descriptor) {
  try {
    fs.closeSync(descriptor);
    return true;
  } catch {
    return false;
  }
}

function removeQuietly(filepath) {
  try {
    fs.unlinkSync(filepath);
    return true;
  } catch {
    return false;
  }
}

function keepOwner(descriptor, existing) {
  if (!existing || typeof process.getuid !== 'function') return;
  if (existing.uid === process.getuid() && existing.gid === process.getgid()) return;
  try {
    fs.fchownSync(descriptor, existing.uid, existing.gid);
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
  }
}

function statOrNull(filepath) {
  try {
    return fs.statSync(filepath);
  } catch {
    return null;
  }
}

function writeProtocolFile(filepath, content) {
  const target = resolveWriteTarget(filepath);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const existing = statOrNull(target);
  const mode = existing ? existing.mode & 0o777 : 0o644;
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', mode);
  let open = true;
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fchmodSync(descriptor, mode);
    keepOwner(descriptor, existing);
    fs.closeSync(descriptor);
    open = false;
    fs.renameSync(temporary, target);
  } catch (error) {
    if (open) closeQuietly(descriptor);
    removeQuietly(temporary);
    throw error;
  }
}

module.exports = { resolveWriteTarget, writeProtocolFile };
