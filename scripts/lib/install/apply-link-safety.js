'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Until 10 June 2026 the Antigravity CLI skills landed as one link per
// skill into the copy EGC installs under the same target root (for the
// Gemini home, ~/.gemini/skills/egc). Those links are EGC's own layout, not
// something the person made: a link below the target root whose resolved
// target sits inside that copy is replaced by the real files on the next
// install (#1400). A link that resolves anywhere else keeps the refusal.
function legacyLinkRoots(root) {
  if (!root) return [];
  const managed = path.join(root, 'skills', 'egc');
  // The link target is compared as a real path, so the managed copy is
  // spelled through the root's own real path too (on macOS the temp and
  // home directories sit behind links: /var is /private/var). Only that
  // alias is accepted: a managed directory that is itself a link to
  // somewhere else is not EGC's copy, and links into it keep the refusal.
  let realRoot;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    return [managed];
  }
  const realManaged = path.join(realRoot, 'skills', 'egc');
  try {
    if (fs.realpathSync.native(managed) !== realManaged) return [];
  } catch {
    // Absent: a link into it dangles and is refused like any other.
  }
  return realManaged === managed ? [managed] : [managed, realManaged];
}

// The resolved target of the link at linkPath when it is EGC's legacy
// layout, null otherwise (a dangling link resolves nowhere and is refused
// like any other).
function legacyLinkTarget(linkPath, root) {
  let resolved;
  try {
    resolved = fs.realpathSync.native(linkPath);
  } catch {
    return null;
  }
  const inside = legacyLinkRoots(root).some(legacyRoot => resolved === legacyRoot || resolved.startsWith(legacyRoot + path.sep));
  return inside ? resolved : null;
}

// Refuses a link at the destination or under a linked directory strictly
// inside the target root. With `migrate` given, a link that is EGC's legacy
// layout is not refused: it is recorded in that list (linkPath, resolvedTo)
// and, unless `dryRun`, removed so the real directory takes its place; the
// unlink removes the link only, never what it pointed at. The apply
// collects with dryRun first and unlinks only after every path passed.
function refuseLinkedDestination(destinationPath, targetRoot, { migrate, dryRun = false } = {}) {
  const root = targetRoot ? path.resolve(targetRoot) : null;
  let probe = path.resolve(destinationPath);
  for (;;) {
    if (isSymbolicLink(probe)) handleLinkedProbe(probe, root, migrate, dryRun);
    const parent = path.dirname(probe);
    if (!insideRoot(parent, probe, root)) break;
    probe = parent;
  }
}

function isSymbolicLink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

// Whether the walk continues to `parent`: only strictly inside the root,
// never the root itself (it may be a link the user made) and never past it.
function insideRoot(parent, probe, root) {
  return Boolean(root) && parent !== probe && parent !== root && parent.startsWith(root + path.sep);
}

// A link found on the walk: refused, unless migration is on and it is
// EGC's legacy layout, in which case it is recorded once (and removed
// unless this is a dry run).
function handleLinkedProbe(probe, root, migrate, dryRun) {
  const resolvedTo = migrate ? legacyLinkTarget(probe, root) : null;
  if (!resolvedTo) throw new Error(`Refusing to write through a symbolic link at ${probe}`);
  if (!migrate.some(entry => entry.linkPath === probe)) migrate.push({ linkPath: probe, resolvedTo });
  if (!dryRun) fs.unlinkSync(probe);
}

function segments(filePath) {
  return path.resolve(filePath).split(path.sep).length;
}

// A shape transition is a destination where the plan must convert an
// existing file into a directory, or the reverse: the recorded source moved
// from one shape to the other (rules/foo.md being a file, then becoming a
// directory keeps its name but not its shape). A naive apply would falter on
// EEXIST here after already writing part of the layout, so the transition is
// resolved first: files are retired through the same identity check
// retirement uses -- a file a previous install recorded and that is still
// byte-identical to something this plan copies may go, everything else is
// refused with a clear message.

module.exports = {
  legacyLinkRoots,
  legacyLinkTarget,
  refuseLinkedDestination,
  isSymbolicLink,
  segments,
};
