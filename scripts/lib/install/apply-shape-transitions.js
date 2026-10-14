'use strict';

const { readInstallState } = require('../install-state');
const fs = require('node:fs');
const path = require('node:path');
const { isSymbolicLink, segments } = require('./apply-link-safety');
const { managedRootsOf, plannedContentHashes, sha256, legacyInstallStatePathsOf } = require('./apply-retirement');
const { findLegacyLinks } = require('./apply-legacy-links');

// Every copy-file destination a plan writes to or into: the planned files
// themselves and the directories that contain them, up to each managed root.
// Only these paths can change shape; a destination the plan stops touching
// is the retirement path's business, not ours.
function plannedWriteShapes(plan) {
  const roots = managedRootsOf(plan);
  const files = new Set();
  const parents = new Set();
  for (const operation of plan.operations) {
    if (operation.kind !== 'copy-file') continue;
    const destinationPath = path.resolve(operation.destinationPath);
    files.add(destinationPath);
    // The directories the install materializes for that file, each strictly
    // inside a managed root: a destination the installer writes outside its
    // roots must not get one of its parents turned into a directory.
    for (let dir = path.dirname(destinationPath); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const root = roots.find(candidate => dir === candidate || dir.startsWith(candidate + path.sep));
      if (!root) break;
      // The root itself is never a planned parent: it may be a link the user
      // made (a dotfiles manager's ~/.claude), and the scan must not lstat it.
      if (dir === root) break;
      parents.add(dir);
    }
  }
  return { files, parents };
}

// The managed copy-file destinations a previous install recorded, keyed by
// their resolved path. A missing or unreadable state explains nothing: the
// caller gets an empty map and every potential retirement is refused, which
// is the honest answer when we cannot prove a file is ours.
function previousStateManagedCopies(plan) {
  const recorded = new Map();
  // Legacy states first, so the current state wins on a destination both
  // record; a state that is there but cannot be read explains nothing.
  const statePaths = [...legacyInstallStatePathsOf(plan), plan.installStatePath];
  const operations = [];
  for (const statePath of statePaths) {
    if (!fs.existsSync(statePath)) continue;
    try {
      operations.push(...(readInstallState(statePath).operations || []));
    } catch {
      return new Map();
    }
  }
  for (const operation of operations) {
    if (operation.kind !== 'copy-file' || operation.ownership !== 'managed') continue;
    recorded.set(path.resolve(operation.destinationPath), operation);
  }
  return recorded;
}

// The identity check for a file a shape transition wants to retire. Where a
// normal retirement also allows the original source file to still exist and
// match, a transition's recorded source is by definition gone or changed
// shape, so identity is only ever established against the files this plan
// copies today. The root is found by explicit containment: a path outside
// every managed root is refused, never removed (managedRootFor's fallback to
// the target root would vouch for foreign territory here).
function isShapeTransitionRemovable(filePath, plan) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const root = managedRootsOf(plan).find(candidate => filePath.startsWith(candidate + path.sep));
  if (!root) return false;
  for (let dir = path.dirname(filePath); dir !== root && dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    if (isSymbolicLink(dir)) return false;
  }
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch {
    return false;
  }
  return plannedContentHashes(plan).has(sha256(content));
}

// Everything inside a directory a dir-to-file transition has to give way for,
// recursed depth-first: the regular files (each must pass identity before it
// can go), the directories that hold them (dropped once empty), and anything
// that is neither -- a link, a socket... -- that refuses the transition
// outright. A directory that cannot even be listed cannot be safely emptied,
// so it refuses too.
function collectShapeBlockingEntries(directory) {
  const files = [];
  const directories = [];
  const blocking = [];
  let inspectable = true;

  const walk = current => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      inspectable = false;
      return;
    }
    for (const entry of entries) {
      const resolved = path.join(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        blocking.push(resolved);
      } else if (entry.isDirectory()) {
        directories.push(resolved);
        walk(resolved);
      } else {
        files.push(resolved);
      }
    }
  };

  walk(directory);
  return { files, directories, blocking, inspectable };
}

// Resolves a destination the plan writes as a directory out of what is today
// a file (the caller has already ruled out a directory and a link/special
// entry on disk): it may be turned into the directory only when the scan can
// prove the file is EGC's by a previous install. Comes back as a refusal
// otherwise, or null when the destination is not a file and no transition
// applies.
function resolveFileToDirCandidate(destinationPath, { recorded, plan, onDiskFile }) {
  if (!onDiskFile) return null;
  const recordedEntry = recorded.get(destinationPath);
  if (!recordedEntry) {
    return {
      refusal: {
        destinationPath,
        reason: 'a file EGC did not install must not be turned into a directory',
      },
    };
  }
  if (!isShapeTransitionRemovable(destinationPath, plan)) {
    return {
      refusal: {
        destinationPath,
        reason: 'a file is in the way that is EGC-modified or changed since install',
      },
    };
  }
  return {
    transition: {
      type: 'file-to-dir',
      destinationPath,
      sourceRelativePath: recordedEntry.sourceRelativePath || '',
    },
  };
}

// Resolves a destination the plan writes as a file out of what is today a
// directory: every regular file inside must be proven EGC's by a previous
// install, or the transition is refused with the directory untouched. A link
// or special entry inside, or a directory that cannot even be listed, refuses
// too -- the walk's empty directories are dropped, being indistinguishable
// from ones the person made.
function resolveDirToFileCandidate(destinationPath, { recorded, plan }) {
  const summary = collectShapeBlockingEntries(destinationPath);
  if (!summary.inspectable) {
    return {
      refusal: {
        destinationPath,
        reason: 'a directory that could not be listed must not be silently emptied',
      },
    };
  }
  if (summary.blocking.length > 0) {
    return {
      refusal: {
        destinationPath,
        reason: `a symbolic link or special file refuses the transition: ${summary.blocking
          .map(filePath => path.relative(path.resolve(destinationPath), filePath))
          .join(', ')}`,
      },
    };
  }
  const unreconciled = summary.files.filter(filePath => {
    const recordedEntry = recorded.get(filePath);
    return !recordedEntry || !isShapeTransitionRemovable(filePath, plan);
  });
  if (unreconciled.length > 0) {
    return {
      refusal: {
        destinationPath,
        reason: `files are in the way whose content is not in this package anymore, so EGC cannot prove they are untouched: ${unreconciled
          .map(filePath => path.relative(path.resolve(destinationPath), filePath))
          .join(', ')}`,
      },
    };
  }
  return {
    transition: {
      type: 'dir-to-file',
      destinationPath,
      children: [...summary.files].sort((a, b) => a.localeCompare(b)),
      directories: [...summary.directories, destinationPath].sort((a, b) => a.localeCompare(b)),
    },
  };
}

// Scans the destinations a plan will write to or into for shape transitions,
// read-only: the dry run lists them and the apply runs them. Anything the
// scan cannot reconcile is returned as a refusal instead of throwing, so a
// dry run can show every problem at once and the apply refuses before the
// first write.
function collectShapeTransitions(plan) {
  const recorded = previousStateManagedCopies(plan);
  const transitions = [];
  const refusals = [];
  const { files: plannedFiles, parents: plannedParents } = plannedWriteShapes(plan);
  const roots = managedRootsOf(plan);
  // The links this run migrates as EGC's own June 2026 legacy layout
  // (#1400). A planned path that is one of them is the apply's business and
  // is left for it; any other link the scan meets is refused here too, so a
  // dry run shows exactly what the apply will do. Resolved on the first link
  // the scan meets, never before one.
  let legacyLinkPaths = null;
  const legacyLinks = () => {
    if (!legacyLinkPaths) legacyLinkPaths = new Set(findLegacyLinks(plan).map(link => link.linkPath));
    return legacyLinkPaths;
  };
  const context = { recorded, plan, plannedFiles, plannedParents, roots, legacyLinks };

  for (const destinationPath of new Set([...plannedFiles, ...plannedParents])) {
    // null: nothing for the scan to do -- the path needs no transition and
    // is not refused (outside every root, not on disk yet, already the
    // planned shape, or a legacy link the apply migrates itself, #1400).
    const result = resolveShapeCandidate(destinationPath, context);
    if (!result) continue;
    if (result.transition) transitions.push(result.transition);
    else if (result.refusal) refusals.push(result.refusal);
  }

  return { transitions, refusals };
}

// Resolves one planned path into a shape transition, a refusal, or null (no
// transition and no refusal: the path needs nothing done to it). The loop
// above only dispatches the result; every branch of the decision lives here,
// so a destination is visited once for one answer.
function resolveShapeCandidate(destinationPath, { recorded, plan, plannedFiles, plannedParents, roots, legacyLinks }) {
  if (!roots.some(candidate => destinationPath === candidate || destinationPath.startsWith(candidate + path.sep))) return null;

  const wantsFile = plannedFiles.has(destinationPath);
  const wantsDirectory = plannedParents.has(destinationPath);

  // The plan both writes this path and writes into it -- structurally
  // impossible, never let install.sh find out the hard way. Raised before
  // the destination is even read, so a broken plan refuses on a fresh
  // install too, and a path in both sets is visited once, for one refusal.
  if (wantsFile && wantsDirectory) {
    return {
      refusal: {
        destinationPath,
        reason: 'the plan writes this path as both a file and a directory',
      },
    };
  }

  let stat;
  try {
    stat = fs.lstatSync(destinationPath);
  } catch {
    return null;
  }
  const onDiskDirectory = stat.isDirectory();
  const onDiskFile = stat.isFile();

  // A link or special entry at the destination is refused unless it is one
  // of EGC's own legacy layout links (#1400) the apply migrates: any other
  // would be written through. Checked for a planned file too, so the scan
  // reports the same refusal the apply raises in either direction.
  if (!onDiskDirectory && !onDiskFile) {
    if (legacyLinks().has(destinationPath)) return null;
    return {
      refusal: {
        destinationPath,
        reason: 'a symbolic link or special file is in the way that EGC would not migrate',
      },
    };
  }

  if (wantsDirectory && !onDiskDirectory) {
    return resolveFileToDirCandidate(destinationPath, { recorded, plan, onDiskFile });
  }

  if (wantsFile && onDiskDirectory) {
    return resolveDirToFileCandidate(destinationPath, { recorded, plan });
  }

  return null;
}

function formatShapeTransitionsRefusal(refusals) {
  const lines = refusals.map(refusal => `  ${refusal.destinationPath}: ${refusal.reason}`);
  return (
    `Shape transition refused:\n${lines.join('\n')}\n` +
    'Move or remove the conflicting destination by hand, then run the install again.'
  );
}

// Converts the collected transitions. Deepest first so a nested transition is
// resolved before the one it is inside. Every file is verified before any is
// removed -- a transition is all-or-nothing, never a child at a time -- so a
// file that changed between the scan and the removal is refused with the
// whole layout still in place, and directories are only removed once empty.
function performShapeTransitions(transitions, plan) {
  const deepestFirst = [...transitions].sort((a, b) => segments(b.destinationPath) - segments(a.destinationPath));
  const offenders = [];
  for (const transition of deepestFirst) {
    const offender = verifyShapeTransition(transition, plan);
    if (offender) offenders.push(offender);
  }
  if (offenders.length > 0) {
    throw new Error(formatShapeTransitionsRefusal(offenders));
  }
  for (const transition of deepestFirst) {
    if (transition.type === 'file-to-dir') performFileToDir(transition);
    else performDirToFile(transition);
  }
}

// Re-checks the bytes of one transition against the disk right before the
// removals, so nothing EGC cannot prove is its own ever goes: the single file
// of a file-to-dir transition, every child of a dir-to-file one. Returns the
// first offender, or null when the transition may proceed.
function verifyShapeTransition(transition, plan) {
  if (transition.type === 'file-to-dir') {
    if (!isShapeTransitionRemovable(transition.destinationPath, plan)) {
      return { destinationPath: transition.destinationPath, reason: 'no longer a byte-identical EGC copy' };
    }
    return null;
  }
  for (const childPath of transition.children) {
    if (!isShapeTransitionRemovable(childPath, plan)) {
      return { destinationPath: childPath, reason: 'no longer a byte-identical EGC copy' };
    }
  }
  return null;
}

// Retires the EGC-installed file making room for the planned directory.
function performFileToDir(transition) {
  fs.rmSync(transition.destinationPath, { force: true });
}

// Retires the EGC-installed directory making room for the planned file: its
// children first, then the directories that held them, deepest first. A
// directory that grew content while the install ran is refused, not removed.
function performDirToFile(transition) {
  for (const childPath of transition.children) {
    fs.rmSync(childPath, { force: true });
  }
  const emptiestFirst = [...transition.directories].sort((a, b) => segments(b) - segments(a));
  for (const directoryPath of emptiestFirst) {
    try {
      fs.rmdirSync(directoryPath);
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
      throw new Error(
        `Refusing to turn ${transition.destinationPath} into a file: ${directoryPath} grew content during the install`,
        { cause: error }
      );
    }
  }
}

module.exports = {
  collectShapeTransitions,
  formatShapeTransitionsRefusal,
  performShapeTransitions,
};
