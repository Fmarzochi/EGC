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

// Where a write or delete of `target` would actually land: the real location
// of its deepest existing ancestor, joined with the tail that does not exist
// yet, so a link anywhere along the path is followed the way the filesystem
// would follow it.
function realizePath(target) {
  let probe = path.resolve(target);
  const tail = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  let real = probe;
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
