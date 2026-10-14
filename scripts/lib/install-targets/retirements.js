'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { isGeneratedRuntimeSourcePath, isHostPlacedSourcePath } = require('../install-source-filters');
const { HOOK_OPERATION_KIND } = require('../claude-settings-hooks');
const { GENERATE_CONTEXT_FILE_KIND, generatedContextTemplate, isGeneratedContextSource } = require('../generated-context-files');
const { listRelativeFiles, normalizeRelativePath } = require('./source-paths');

// The destinations one scaffold operation writes, added to `covered`. A
// directory copy covers the files it copies today, listed as
// materializeScaffoldOperation lists them (names unchanged; ignored names,
// generated install-states and host-placed sources left out), not every
// path under its destination; a directory that cannot be listed shields
// its whole subtree.
function addDirectoryCoverage(source, sourceDir, resolvedDestination, covered) {
  try {
    for (const relativeFile of listRelativeFiles(sourceDir)) {
      const sourceFile = `${source}/${relativeFile}`;
      if (isGeneratedRuntimeSourcePath(sourceFile) || isHostPlacedSourcePath(sourceFile)) continue;
      covered.files.add(path.join(resolvedDestination, ...relativeFile.split('/')));
    }
  } catch {
    covered.dirs.add(resolvedDestination);
  }
}

function addOperationCoverage(operation, repoRoot, covered) {
  const destination = typeof operation.destinationPath === 'string' ? operation.destinationPath : null;
  if (!destination) return;
  const resolvedDestination = path.resolve(destination);
  const source = typeof operation.sourceRelativePath === 'string' ? normalizeRelativePath(operation.sourceRelativePath) : null;
  // Nothing repo-relative to check the shape of (a merge or hook operation
  // may carry its payload some other way), or a source unreadable from
  // here: treat the destination as covered rather than guess, so it is
  // never offered up for retirement by mistake.
  if (!source) {
    covered.files.add(resolvedDestination);
    return;
  }
  const sourcePath = path.join(repoRoot, ...source.split('/'));
  let stat;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    covered.files.add(resolvedDestination);
    return;
  }
  if (stat.isDirectory()) addDirectoryCoverage(source, sourcePath, resolvedDestination, covered);
  else covered.files.add(resolvedDestination);
}

// What today's scaffold operations would actually write, at the
// granularity the install-state records: one destination per file, so a
// file that left a planned directory, or another module's file under a
// directory copied onto the target root itself (codex's `.agents`, egc's
// `.gemini-plugin`, cursor's `.cursor/scripts`), is no longer shielded.
function collectCurrentlyCoveredDestinations(operations, repoRoot) {
  const covered = { files: new Set(), dirs: new Set() };
  for (const operation of Array.isArray(operations) ? operations : []) {
    addOperationCoverage(operation, repoRoot, covered);
  }
  return covered;
}

function isDestinationCovered(resolved, { files, dirs }) {
  if (files.has(resolved)) return true;
  for (const dir of dirs) {
    if (resolved === dir || resolved.startsWith(dir + path.sep)) return true;
  }
  return false;
}

// The roots an adapter may legitimately write install files under. Most
// adapters write everything under their own resolveRoot(), but a few
// deliberately land copies in a second location (Amp's plugin scripts go to
// ~/.config/amp/plugins/ via resolveAmpConfigRoot(), distinct from its skills
// root ~/.amp/). A retirement candidate is only ever considered for one of
// these trusted roots, so a target with a second root must declare it here or
// its own writes can never be retired.
function resolveAdapterManagedRoots(adapter, input = {}) {
  if (typeof adapter.resolveManagedRoots === 'function') {
    const declared = adapter.resolveManagedRoots(input);
    if (Array.isArray(declared)) {
      return declared.filter(root => typeof root === 'string' && root.length > 0);
    }
  }
  return [adapter.resolveRoot(input)];
}

// The managed copy-file and generated context file operations an
// install-state records, the shape both the sibling check and the
// retirement diff read.
function recordedManagedCopies(state) {
  const operations = Array.isArray(state?.operations) ? state.operations : [];
  return operations.filter(operation => (
    operation.ownership === 'managed'
    && (operation.kind === 'copy-file' || operation.kind === GENERATE_CONTEXT_FILE_KIND)
    && typeof operation.destinationPath === 'string'
    && operation.destinationPath.length > 0
  ));
}

// The marker for an install-state that exists but cannot be read or parsed:
// unlike a missing one it may still record destinations, so it must never be
// mistaken for an empty one.
const UNREADABLE_STATE = Symbol('unreadable install-state');

// An install-state, null when nothing sits at the path (a definite ENOENT
// and nothing else: a dangling link, a parent that cannot be inspected or
// is not a directory all count as a state that cannot be trusted), and
// UNREADABLE_STATE when something is there but cannot be read or parsed.
function readInstallStateOrNull(statePath) {
  if (typeof statePath !== 'string' || statePath.length === 0) return null;
  try {
    fs.lstatSync(statePath);
  } catch (error) {
    return error.code === 'ENOENT' ? null : UNREADABLE_STATE;
  }
  const { readInstallState } = require('../install-state');
  try {
    return readInstallState(statePath);
  } catch {
    return UNREADABLE_STATE;
  }
}

function collectRecordedDestinations(adapter, input) {
  const statePaths = [adapter.getInstallStatePath(input), ...adapter.resolveLegacyInstallStatePaths(input)];
  const destinations = [];
  for (const statePath of statePaths) {
    const state = readInstallStateOrNull(statePath);
    if (state === UNREADABLE_STATE) return null;
    const operations = state && Array.isArray(state.operations) ? state.operations : [];
    destinations.push(...operations.map(operation => path.resolve(String(operation.destinationPath || ''))));
  }
  return destinations;
}

function isSameTree(sourcePath, destinationPath) {
  try {
    const source = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
    const destination = fs.lstatSync(destinationPath, { throwIfNoEntry: false });
    if (!source || !destination) return false;
    if (source.isFile() && destination.isFile()) {
      return fs.readFileSync(sourcePath).equals(fs.readFileSync(destinationPath));
    }
    if (!source.isDirectory() || !destination.isDirectory()) return false;
    const sourceEntries = fs.readdirSync(sourcePath).sort();
    const destinationEntries = fs.readdirSync(destinationPath).sort();
    if (sourceEntries.join('\n') !== destinationEntries.join('\n')) return false;
    return sourceEntries.every(entry => isSameTree(path.join(sourcePath, entry), path.join(destinationPath, entry)));
  } catch {
    return false;
  }
}

function isPersonOwnedDestination(destination, sourcePath, recordedDestinations) {
  const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return false;
  const resolved = path.resolve(destination);
  if (recordedDestinations?.some(recorded => recorded === resolved || recorded.startsWith(resolved + path.sep))) {
    return false;
  }
  return !(sourcePath && isSameTree(sourcePath, resolved));
}

// Destinations a sibling adapter sharing the same trusted root still records
// as its own managed copies. codex-home, goose-home and openhands-home all
// write skills into the shared ~/.agents tree, each with its own
// install-state: if one adapter removes a skill from its plan, its retirement
// diff must not delete the file another adapter still installs. The sibling
// coverage check reads those sibling state files (passed in by registry.js
// when it plans) and refuses any candidate another adapter still owns. A
// sibling with no state file owns nothing; a sibling whose state exists but
// cannot be read may own any of them, so the answer is null: unknown
// ownership fails closed, never open.
function collectSiblingOwnedDestinations(statePaths) {
  const owned = new Set();
  for (const statePath of Array.isArray(statePaths) ? statePaths : []) {
    const siblingState = readInstallStateOrNull(statePath);
    if (siblingState === UNREADABLE_STATE) return null;
    for (const operation of recordedManagedCopies(siblingState)) {
      owned.add(path.resolve(operation.destinationPath));
    }
  }
  return owned;
}

// Whether a recorded destination is still a candidate once the boundaries
// apply: inside a root this adapter manages, not already offered, not owned
// by a sibling, and not covered by what today's plan writes.
function isRetirementCandidate(resolved, { managedRoots, seen, siblingOwned, covered }) {
  if (!managedRoots.some(root => resolved.startsWith(root + path.sep))) return false;
  if (seen.has(resolved) || siblingOwned.has(resolved)) return false;
  return !isDestinationCovered(resolved, covered);
}

// The default planRetirements body: compares the previous install-state's
// managed copy-file operations against what this plan would write today. A
// destination the state remembers EGC copied, recorded by a module this plan
// still selects, and that no scaffold operation in the plan still covers, is
// offered up for retirement. Renaming or dropping a command, prompt, rule or
// skill from the package is exactly this: the old destination stops being
// covered and is cleaned up on the next install or auto-update.
//
// The module gate is what tells a rename apart from a module that simply was
// not selected this run: a targeted --modules install, or a narrower profile,
// leaves the files of the modules it did not select exactly where they are.
//
// Only recorded copy-file and generated context file operations are diffed;
// merge-json and hook operations (settings.json entries, MCP config merges)
// have no counterpart here yet, an open question left by #1412. A generated
// file is compared against the hash of the text EGC wrote, recorded at
// install time, or the current template for a state recorded before that.
//
// This only decides which destinations are candidates. The identity check
// that decides whether one is actually safe to delete (a regular file,
// reached through no link, byte-identical to the source EGC copied) happens
// later in install/apply-retirement.js's isRetirableFile, the same test #1411
// introduced for OpenCode. A source no longer in the repository (the file was
// renamed, moved or removed) passes that check only when the bytes on disk
// match a file the plan copies today; otherwise the candidate is listed
// nowhere and the file is left in place, never deleted on the strength of the
// state entry alone.
// The states whose managed copies the diff reads: the current one and any
// legacy one the adapter still answers for. Trusted only when at least one
// state was read and none was unreadable: one unreadable state makes the
// whole set untrusted, the same conservative answer as for a single one.
function readRecordedStates(adapter, input) {
  const statePaths = [adapter.getInstallStatePath(input), ...adapter.resolveLegacyInstallStatePaths(input)];
  const operations = [];
  let found = false;
  for (const statePath of statePaths) {
    const state = readInstallStateOrNull(statePath);
    if (state === UNREADABLE_STATE) return { trusted: false, operations: [] };
    if (!state) continue;
    found = true;
    operations.push(...(Array.isArray(state.operations) ? state.operations : []));
  }
  return { trusted: found, operations };
}

function planGenericRetirements(input, adapter) {
  // The operations being diffed were planned against the package source
  // root; without it identities cannot be compared, so the conservative
  // answer is to retire nothing rather than to guess a directory.
  const repoRoot = typeof input.repoRoot === 'string' && input.repoRoot.length > 0 ? input.repoRoot : null;
  if (!repoRoot) return [];
  const previous = readRecordedStates(adapter, input);
  if (!previous.trusted) return [];

  // Destinations another adapter sharing this root still manages: never a
  // retirement candidate here, whatever this adapter's own coverage says. A
  // sibling state that cannot be read may still own any of them, so nothing
  // is retired until it can be trusted again.
  const siblingOwned = collectSiblingOwnedDestinations(input.siblingStatePaths);
  if (!siblingOwned) return [];

  const operations = Array.isArray(input.operations) ? input.operations : adapter.planOperations(input);
  const activeModuleIds = collectActiveModuleIds(input, operations, adapter);
  const boundaries = {
    managedRoots: resolveAdapterManagedRoots(adapter, input).map(root => path.resolve(root)),
    seen: new Set(),
    siblingOwned,
    covered: collectCurrentlyCoveredDestinations(operations, repoRoot),
  };

  const retirements = [];
  for (const operation of recordedManagedCopies(previous)) {
    if (!activeModuleIds.has(operation.moduleId)) continue;
    const resolved = path.resolve(operation.destinationPath);
    if (!isRetirementCandidate(resolved, boundaries)) continue;
    const source = recordedSourceOf(operation);
    if (!source) continue;
    if (isUnverifiableGeneratedRecord(operation, source)) continue;
    boundaries.seen.add(resolved);
    retirements.push(retirementOf(operation, resolved, source, repoRoot));
  }
  return retirements;
}

// The file EGC copied there, for the apply to compare against: a file the
// person replaced since is theirs and stays. A transformed copy is compared
// against the transformed source.
// The modules this install still carries: the ones the person selected plus
// the ones the adapter plans on its own (hook scripts and their entries,
// recorded under ids no manifest lists). Whatever such a module no longer
// plans has left the plan; a module that is no longer installed at all is
// left to the uninstall, unless the adapter declares it retired: then what
// it recorded leaves with it (the Token Crusher hook on Antigravity, which
// never fired, is the first).
function collectActiveModuleIds(input, operations, adapter) {
  const active = new Set(Array.isArray(adapter?.retiredModuleIds) ? adapter.retiredModuleIds : []);
  for (const module of Array.isArray(input.modules) ? input.modules : []) {
    if (module && typeof module.id === 'string') active.add(module.id);
  }
  for (const operation of operations) {
    if (operation && typeof operation.moduleId === 'string') active.add(operation.moduleId);
  }
  return active;
}

function recordedManagedHooks(state) {
  const operations = Array.isArray(state?.operations) ? state.operations : [];
  return operations.filter(operation => (
    operation.ownership === 'managed'
    && operation.kind === HOOK_OPERATION_KIND
    && [operation.destinationPath, operation.hookEvent, operation.hookScriptPath]
      .every(value => typeof value === 'string' && value.length > 0)
  ));
}

// One entry is one script under one event in one file; the matcher is part
// of what the plan asks for, so an entry that only changed matcher is
// retired and written again.
function hookEntryKey(operation) {
  return [path.resolve(operation.destinationPath), operation.hookEvent, path.resolve(operation.hookScriptPath)].join('\n');
}

function hookEntryIdentity(operation) {
  return `${hookEntryKey(operation)}\n${operation.hookMatcher || ''}`;
}

// Entries another adapter's state still records are never retired here;
// one unreadable sibling state makes every entry untouchable.
function collectSiblingHookKeys(statePaths) {
  const keys = new Set();
  for (const statePath of Array.isArray(statePaths) ? statePaths : []) {
    const siblingState = readInstallStateOrNull(statePath);
    if (siblingState === UNREADABLE_STATE) return null;
    for (const operation of recordedManagedHooks(siblingState)) keys.add(hookEntryKey(operation));
  }
  return keys;
}

// The hook entries a previous install of this adapter recorded, under a
// module the install still carries, that the current plan no longer makes
// (Devin Desktop's Cascade events, removed with Cascade on 2026-09-08, are
// the first). The apply removes each through the handler the uninstall
// uses, once the current entries are written. Only files under the
// adapter's managed roots are touched, and only when every recorded state
// can be read.
function planHookRetirements(input, adapter) {
  const previous = readRecordedStates(adapter, input);
  if (!previous.trusted) return [];
  const siblingKeys = collectSiblingHookKeys(input.siblingStatePaths);
  if (!siblingKeys) return [];

  const operations = Array.isArray(input.operations) ? input.operations : adapter.planOperations(input);
  const planned = new Set(operations.filter(operation => operation?.kind === HOOK_OPERATION_KIND).map(hookEntryIdentity));
  const activeModuleIds = collectActiveModuleIds(input, operations, adapter);
  const managedRoots = resolveAdapterManagedRoots(adapter, input).map(root => path.resolve(root));
  const seen = new Set();
  const retirements = [];
  for (const operation of recordedManagedHooks(previous)) {
    const identity = hookEntryIdentity(operation);
    const destinationPath = path.resolve(operation.destinationPath);
    const isManaged = managedRoots.some(root => destinationPath.startsWith(root + path.sep));
    if (!isManaged || !activeModuleIds.has(operation.moduleId)) continue;
    if (planned.has(identity) || seen.has(identity) || siblingKeys.has(hookEntryKey(operation))) continue;
    seen.add(identity);
    retirements.push({
      kind: HOOK_OPERATION_KIND,
      moduleId: operation.moduleId,
      destinationPath,
      hookEvent: operation.hookEvent,
      hookScriptPath: operation.hookScriptPath,
      ...(operation.hookMatcher ? { hookMatcher: operation.hookMatcher } : {}),
      reason: 'hook entry left the install plan',
    });
  }
  return retirements;
}

function recordedSourceOf(operation) {
  return normalizeRelativePath(String(operation.sourceRelativePath || ''));
}

function isUnverifiableGeneratedRecord(operation, source) {
  return operation.kind === GENERATE_CONTEXT_FILE_KIND
    && typeof operation.contentSha256 !== 'string'
    && !isGeneratedContextSource(source);
}

function recordedContentSha256(operation, source) {
  if (typeof operation.contentSha256 === 'string') return operation.contentSha256;
  if (operation.kind === GENERATE_CONTEXT_FILE_KIND) {
    return crypto.createHash('sha256').update(generatedContextTemplate(source), 'utf8').digest('hex');
  }
  return null;
}

function retirementOf(operation, destinationPath, source, repoRoot) {
  const contentSha256 = recordedContentSha256(operation, source);
  return {
    destinationPath,
    sourceRelativePath: source,
    sourcePath: path.join(repoRoot, ...source.split('/')),
    ...(operation.transform ? { transform: operation.transform } : {}),
    ...(contentSha256 ? { contentSha256 } : {}),
    reason: 'file left the install plan',
  };
}

module.exports = {
  UNREADABLE_STATE,
  collectRecordedDestinations,
  collectSiblingOwnedDestinations,
  isPersonOwnedDestination,
  isSameTree,
  planGenericRetirements,
  planHookRetirements,
  readInstallStateOrNull,
  resolveAdapterManagedRoots,
};
