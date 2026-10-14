'use strict';

const { GENERATE_CONTEXT_FILE_KIND } = require('../generated-context-files');
const fs = require('node:fs');
const path = require('node:path');
const { legacyLinkRoots, legacyLinkTarget, refuseLinkedDestination, isSymbolicLink, segments } = require('./apply-link-safety');
const { managedRootFor, removeEmptyParents } = require('./apply-retirement');

// Every path the apply checks for links: the state file and each
// operation, in that order.
function checkedDestinations(plan) {
  const paths = [plan.installStatePath];
  for (const operation of plan.operations) paths.push(operation.destinationPath);
  return paths.filter(Boolean);
}

// The legacy links a plan would migrate, without touching anything. With
// `strict`, a link that is not ours throws here, before anything is
// removed; without it (the dry run) such a link is left for the apply to
// refuse and only the migratable ones are listed. The dry run and the
// apply walk the same paths, so the list is what the apply will do.
function findLegacyLinks(plan, { strict = false } = {}) {
  const migrate = [];
  const targetRoot = plan.targetRoot ? path.resolve(plan.targetRoot) : null;
  for (const destinationPath of checkedDestinations(plan)) {
    // The legacy layout (#1400) only ever lived under the target root: a
    // link under a declared second root is refused outright.
    const root = managedRootFor(plan, destinationPath);
    const options = root === targetRoot ? { migrate, dryRun: true } : { dryRun: true };
    try {
      refuseLinkedDestination(destinationPath, root, options);
    } catch (error) {
      if (strict) throw error;
    }
  }
  return migrate;
}

// Removes the collected legacy links, deepest path first so a link seen
// through another is gone before the one it was seen through. Each link is
// checked again right before the unlink: it must still be a link resolving
// to the target recorded by the scan, otherwise the path changed under the
// install and is refused, never removed. unlink never follows a link, so
// only the link itself goes.
const FORMER_LEGACY_LINK_DIRECTORIES = [['antigravity-cli', 'skills']];

function hasLinkedComponent(fromRoot, targetPath) {
  const relative = path.relative(fromRoot, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return true;
  let current = fromRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current, { throwIfNoEntry: false });
    } catch {
      return true;
    }
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

function pointsIntoLegacyRoot(linkPath, root) {
  let target;
  try {
    target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
  } catch {
    return null;
  }
  const candidates = [path.join(root, 'skills', 'egc'), ...legacyLinkRoots(root)];
  const matched = candidates.find(candidate => target === candidate || target.startsWith(candidate + path.sep));
  if (!matched) return null;
  return hasLinkedComponent(path.dirname(path.dirname(matched)), target) ? null : target;
}

function isScannableDirectory(directory, root) {
  if (hasLinkedComponent(root, directory)) return false;
  try {
    return fs.lstatSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function readDirectoryEntries(directory) {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function findStrandedLegacyLinks(plan) {
  const root = plan.targetRoot ? path.resolve(plan.targetRoot) : null;
  if (!root) return [];
  const planned = new Set((Array.isArray(plan.operations) ? plan.operations : []).map(operation => path.resolve(operation.destinationPath)));
  const stranded = [];
  for (const segments of FORMER_LEGACY_LINK_DIRECTORIES) {
    const directory = path.join(root, ...segments);
    if (!isScannableDirectory(directory, root)) continue;
    for (const entry of readDirectoryEntries(directory)) {
      const linkPath = path.join(directory, entry);
      if (planned.has(linkPath) || !isSymbolicLink(linkPath)) continue;
      const pointedAt = pointsIntoLegacyRoot(linkPath, root);
      if (pointedAt) stranded.push({ linkPath, pointedAt });
    }
  }
  return stranded;
}

function removeStrandedLegacyLinks(links, targetRoot) {
  if (!targetRoot || links.length === 0) return [];
  const root = path.resolve(targetRoot);
  const removed = [];
  for (const link of links) {
    if (!isScannableDirectory(path.dirname(link.linkPath), root)) continue;
    if (!isSymbolicLink(link.linkPath) || pointsIntoLegacyRoot(link.linkPath, root) !== link.pointedAt) continue;
    fs.unlinkSync(link.linkPath);
    removed.push(link);
    removeEmptyParents(path.dirname(link.linkPath), root);
  }
  return removed;
}

function recordWrittenContentHashes(plan, written) {
  for (const operation of plan.statePreview?.operations || []) {
    const hash = written.get(path.resolve(String(operation.destinationPath || '')));
    if (hash && (operation.kind === 'copy-file' || operation.kind === GENERATE_CONTEXT_FILE_KIND)) operation.contentSha256 = hash;
  }
}

function removeLegacyLinks(links, targetRoot) {
  const root = targetRoot ? path.resolve(targetRoot) : null;
  const deepestFirst = [...links].sort((a, b) => segments(b.linkPath) - segments(a.linkPath));
  // Every link is checked before any is removed, so a link that changed is
  // refused with the layout still whole, not after part of it is gone.
  for (const link of deepestFirst) assertStillLegacyLink(link, root);
  for (const link of deepestFirst) {
    assertStillLegacyLink(link, root);
    fs.unlinkSync(link.linkPath);
  }
}

function assertStillLegacyLink(link, root) {
  let stat;
  try {
    stat = fs.lstatSync(link.linkPath);
  } catch {
    stat = null;
  }
  if (!stat?.isSymbolicLink() || legacyLinkTarget(link.linkPath, root) !== link.resolvedTo) {
    throw new Error(`Refusing to write through a symbolic link at ${link.linkPath}: it changed during the install`);
  }
}

module.exports = {
  checkedDestinations,
  findLegacyLinks,
  findStrandedLegacyLinks,
  removeStrandedLegacyLinks,
  recordWrittenContentHashes,
  removeLegacyLinks,
};
