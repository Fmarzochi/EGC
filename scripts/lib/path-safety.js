'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Path predicates shared by the install-state validator and the replay
// containment in the lifecycle, so the two cannot drift apart.

function hasParentSegment(value) {
  return String(value).split(/[\\/]/).includes('..');
}

// Absolute on either platform family: a POSIX root, a drive letter or a UNC
// share. The state file may have been written on another host.
const ANCHORED_RE = /^(?:[\\/]|[A-Za-z]:[\\/])/;

function isAnchoredPath(value) {
  return typeof value === 'string' && ANCHORED_RE.test(value);
}

// Linux gives up on a path after this many links (ELOOP); past it a chain is
// no longer followed.
const MAX_LINK_HOPS = 40;

function readLinkOrNull(entry) {
  try {
    return fs.lstatSync(entry).isSymbolicLink() ? fs.readlinkSync(entry) : null;
  } catch {
    return null;
  }
}

// Where a write or delete of `target` would actually land: the real location
// of its deepest existing ancestor, joined with the tail that does not exist
// yet, so a link anywhere along the path is followed the way the filesystem
// would follow it. That includes a link to something not there yet, which a
// write would create at the link's destination; its text is read from the
// folder the link really sits in.
function realizePath(target, hops = 0) {
  let probe = path.resolve(target);
  const tail = [];
  while (!fs.existsSync(probe)) {
    const link = hops < MAX_LINK_HOPS ? readLinkOrNull(probe) : null;
    if (link !== null) {
      const destination = path.resolve(realizePath(path.dirname(probe), hops + 1), link);
      return realizePath(path.join(destination, ...tail), hops + 1);
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  let real;
  try {
    real = fs.realpathSync(probe);
  } catch {
    real = probe;
  }
  return path.join(real, ...tail);
}

function isInsideReal(target, root) {
  const relative = path.relative(realizePath(root), realizePath(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = { hasParentSegment, isAnchoredPath, isInsideReal, realizePath };
