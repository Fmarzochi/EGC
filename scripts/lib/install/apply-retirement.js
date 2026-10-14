'use strict';

const { readInstallState } = require('../install-state');
const { plannedFileContent } = require('./copy-transforms');
const { HOOK_OPERATION_KIND, applyManagedHookOperation, resolveHookOperationHandlers } = require('../claude-settings-hooks');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { refuseLinkedDestination, isSymbolicLink } = require('./apply-link-safety');

// Files a target wants removed: written by an earlier EGC install (the
// target reads them from the previous install-state) and no longer part of
// the plan. Only a regular file at the recorded path goes; a link or a
// directory there is not what EGC wrote and is left alone. Directories the
// removal empties are dropped too, up to the target root.
function retirePlannedFiles(plan) {
  const retired = [];
  for (const { retirement, root } of retirableEntries(plan)) {
    fs.unlinkSync(retirement.destinationPath);
    retired.push(retirement);
    removeEmptyParents(path.dirname(retirement.destinationPath), root);
  }
  return retired;
}

// The roots a plan writes under: the target root, plus any second root the
// adapter declared (Amp's plugin config directory). A destination is checked
// against the root it belongs to, so the linked-ancestor walk and the
// empty-parent climb cover that root and never leave it.
function managedRootsOf(plan) {
  const declared = Array.isArray(plan.managedRoots) ? plan.managedRoots : [];
  const roots = [plan.targetRoot, ...declared]
    .filter(root => typeof root === 'string' && root.length > 0)
    .map(root => path.resolve(root));
  return [...new Set(roots)];
}

// The managed root a destination falls under; a destination outside every
// declared root is walked against the target root, as before.
function managedRootFor(plan, destinationPath) {
  const resolved = path.resolve(destinationPath);
  const root = managedRootsOf(plan).find(candidate => resolved === candidate || resolved.startsWith(candidate + path.sep));
  return root || plan.targetRoot;
}

// The retirements of a plan that would actually be removed right now, each
// with the root it belongs to: the same test the apply runs, so a dry run
// lists exactly what the apply does.
function retirableEntries(plan) {
  const roots = managedRootsOf(plan);
  const result = [];
  for (const retirement of Array.isArray(plan.retirements) ? plan.retirements : []) {
    const filePath = path.resolve(retirement.destinationPath);
    const root = roots.find(candidate => filePath.startsWith(candidate + path.sep));
    if (!root) continue;
    if (!isRetirableFile(filePath, root, retirement.sourcePath, plan, retirement.transform, retirement.contentSha256)) continue;
    result.push({ retirement: { ...retirement, destinationPath: filePath }, root });
  }
  return result;
}

function retirableFiles(plan) {
  return retirableEntries(plan).map(entry => entry.retirement);
}

// The hook entries of plan.hookRetirements still present in their files,
// for the dry run to list: the inspect handler of each event answers 'ok'
// only for an EGC entry that is there.
function retirableHooks(plan) {
  return (Array.isArray(plan.hookRetirements) ? plan.hookRetirements : [])
    .filter(retirement => resolveHookOperationHandlers(retirement.hookEvent).inspect(retirement) === 'ok');
}

function hookEntryKeyOf(operation) {
  return [path.resolve(operation.destinationPath), operation.hookEvent, path.resolve(operation.hookScriptPath)].join('\n');
}

function isEmptyJsonObjectFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
  return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
}

// The hooks files the given retirements would leave with nothing in them,
// for the dry run to list and the apply to remove: each handler runs its
// removal on a scratch copy of the file, so the answer is the one the apply
// gives, whatever the hook format. A file that ends `{}` held only EGC's
// own entries; nothing of the person's is in it.
function predictEmptiedHooksFiles(retirements) {
  const byFile = new Map();
  for (const retirement of Array.isArray(retirements) ? retirements : []) {
    const filePath = path.resolve(retirement.destinationPath);
    byFile.set(filePath, [...(byFile.get(filePath) || []), retirement]);
  }
  const emptied = [];
  for (const [filePath, entries] of byFile) {
    if (!fs.existsSync(filePath)) continue;
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egc-hooks-retire-'));
    const scratch = path.join(scratchDir, path.basename(filePath));
    try {
      fs.copyFileSync(filePath, scratch);
      for (const retirement of entries) {
        resolveHookOperationHandlers(retirement.hookEvent).remove({ ...retirement, destinationPath: scratch });
      }
      if (isEmptyJsonObjectFile(scratch)) emptied.push(filePath);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }
  return emptied;
}

// The dry-run counterpart of the removal below: the files the retirable
// entries would empty.
function retirableEmptiedHooksFiles(plan) {
  return predictEmptiedHooksFiles(retirableHooks(plan));
}

// Removes the hooks files the retirements emptied, checked again on disk:
// a file a current operation wrote into since is no longer empty and stays.
function removeEmptiedHooksFiles(predicted) {
  return predicted.filter(filePath => {
    if (!isEmptyJsonObjectFile(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  });
}

// Removes each hook entry that left the plan through the handler the
// uninstall uses. It runs once the current entries are written, so an
// install that stops half-way never leaves the person without either set.
// The handlers remove by script, event and file, which also strips a
// current entry of that same script (an entry that only changed matcher):
// that one is written again. Reports the ones removed.
function retirePlannedHooks(plan) {
  const retired = [];
  for (const retirement of Array.isArray(plan.hookRetirements) ? plan.hookRetirements : []) {
    refuseLinkedDestination(retirement.destinationPath, managedRootFor(plan, retirement.destinationPath));
    const outcome = resolveHookOperationHandlers(retirement.hookEvent).remove(retirement);
    if (outcome?.changed) retired.push(retirement);
  }
  const retiredKeys = new Set(retired.map(hookEntryKeyOf));
  for (const operation of plan.operations) {
    if (operation.kind === HOOK_OPERATION_KIND && retiredKeys.has(hookEntryKeyOf(operation))) {
      applyManagedHookOperation(operation);
    }
  }
  return retired;
}

const plannedContentHashesByPlan = new WeakMap();

// The content of every file the plan copies, hashed once per plan and only
// when a candidate needs it: a candidate whose recorded source is gone (the
// file was renamed or moved in the package) is still EGC's when its bytes
// match a file the plan writes today.
function plannedContentHashes(plan) {
  if (plannedContentHashesByPlan.has(plan)) return plannedContentHashesByPlan.get(plan);
  const hashes = new Set();
  for (const operation of Array.isArray(plan.operations) ? plan.operations : []) {
    if (operation.kind !== 'copy-file' || typeof operation.sourcePath !== 'string') continue;
    try {
      hashes.add(sha256(plannedFileContent(operation.sourcePath, operation.transform)));
    } catch {
      // An unreadable source vouches for nothing.
    }
  }
  plannedContentHashesByPlan.set(plan, hashes);
  return hashes;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Whether the file at filePath is the one EGC wrote and may go: a regular
// file (never a link), reached through no link between the root and it (a
// linked ancestor would point the unlink outside the root), and byte-identical
// to what EGC copied: the recorded source when it is still there, or, when
// that source is gone because the file was renamed or moved in the package, a
// file the plan copies today. A file the person replaced since is theirs, and
// a file whose source is gone and matches nothing the plan writes cannot be
// told apart from one, so both stay.
function isRetirableFile(filePath, root, sourcePath, plan = {}, transform = undefined, recordedSha256 = undefined) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  for (let dir = path.dirname(filePath); dir !== root && dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    if (isSymbolicLink(dir)) return false;
  }
  if (!sourcePath) return false;
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch {
    return false;
  }
  if (typeof recordedSha256 === 'string' && recordedSha256.length > 0) {
    return sha256(content) === recordedSha256;
  }
  try {
    const source = fs.statSync(sourcePath);
    if (!source.isFile()) return false;
    return plannedFileContent(sourcePath, transform).equals(content);
  } catch (error) {
    // Only a source that is gone falls through to the content match; any
    // other failure to read it keeps the file.
    if (error.code !== 'ENOENT') return false;
  }
  return plannedContentHashes(plan).has(sha256(content));
}

function removeEmptyParents(dirPath, root) {
  let current = dirPath;
  while (current !== root && current.startsWith(root + path.sep)) {
    try {
      if (fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function legacyInstallStatePathsOf(plan) {
  return Array.isArray(plan.legacyInstallStatePaths) ? plan.legacyInstallStatePaths : [];
}

function isReadableInstallState(statePath) {
  try {
    readInstallState(statePath);
    return true;
  } catch {
    return false;
  }
}

// The states the adapter wrote under a root it no longer picks: replaced by
// the state just written, so they leave (each is EGC's own file). One that
// cannot be read stays, since the copies it records were not retired.
function removeLegacyInstallStates(plan) {
  const current = path.resolve(plan.installStatePath);
  for (const statePath of legacyInstallStatePathsOf(plan)) {
    if (path.resolve(statePath) === current) continue;
    if (!isReadableInstallState(statePath)) continue;
    fs.rmSync(statePath, { force: true });
  }
}

module.exports = {
  retirePlannedFiles,
  managedRootsOf,
  managedRootFor,
  retirableFiles,
  retirableHooks,
  predictEmptiedHooksFiles,
  retirableEmptiedHooksFiles,
  removeEmptiedHooksFiles,
  retirePlannedHooks,
  plannedContentHashes,
  sha256,
  removeEmptyParents,
  legacyInstallStatePathsOf,
  removeLegacyInstallStates,
};
