'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_LINK_HOPS = 40;

const MISSING = new Set(['ENOENT', 'ENOTDIR']);

function lstatOrNull(filepath) {
  try {
    return fs.lstatSync(filepath);
  } catch (error) {
    if (MISSING.has(error.code)) return null;
    throw error;
  }
}

function realpathOrNull(filepath) {
  try {
    return fs.realpathSync.native(filepath);
  } catch (error) {
    if (MISSING.has(error.code)) return null;
    throw error;
  }
}

function followLink(linkPath) {
  const destination = fs.readlinkSync(linkPath);
  const joined = path.isAbsolute(destination) ? destination : `${path.dirname(linkPath)}${path.sep}${destination}`;
  const real = realpathOrNull(joined);
  if (real) return { path: real, resolved: true };
  const parent = realpathOrNull(path.dirname(joined));
  if (!parent) {
    throw Object.assign(new Error(`symbolic link ${linkPath} points to ${destination}, whose directory does not exist`), { code: 'ENOENT' });
  }
  return { path: path.join(parent, path.basename(joined)), resolved: false };
}

function resolveWriteTarget(filepath) {
  let current = path.resolve(filepath);
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
    const stat = lstatOrNull(current);
    if (!stat || !stat.isSymbolicLink()) return current;
    const next = followLink(current);
    if (next.resolved) return next.path;
    current = next.path;
  }
  throw Object.assign(new Error(`too many levels of symbolic links: ${filepath}`), { code: 'ELOOP' });
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
  } catch (error) {
    if (MISSING.has(error.code)) return null;
    throw error;
  }
}

function writeProtocolFile(filepath, content) {
  const target = resolveWriteTarget(filepath);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const existing = statOrNull(target);
  if (existing) fs.accessSync(target, fs.constants.W_OK);
  const temporary = path.join(directory, `.egc-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', existing ? existing.mode & 0o777 : 0o666);
  let open = true;
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    if (existing) fs.fchmodSync(descriptor, existing.mode & 0o777);
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
