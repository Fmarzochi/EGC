'use strict';

// Uninstall planning and execution for installed states.
// Part of the install-lifecycle.js split; that file re-exports the public surface.

const fs = require('node:fs');
const path = require('node:path');
const { fileKey } = require('./path-safety');
const {
  collectSiblingInstallStatePaths,
  listInstallTargetAdapters,
} = require('./install-targets/registry');
const {
  UNREADABLE_STATE,
  collectSiblingOwnedDestinations,
  readInstallStateOrNull,
} = require('./install-targets/helpers');
const { getManagedOperations, findEscapingOperation } = require('./install-lifecycle-core');
const { executeUninstallOperation } = require('./install-lifecycle-operations');
const { lifecycleRoots, existingInstallStates } = require('./install-lifecycle-doctor');

function cleanupEmptyParentDirs(filePath, stopAt) {
  let currentPath = path.dirname(filePath);
  const normalizedStopAt = path.resolve(stopAt);

  while (
    currentPath
    && path.resolve(currentPath).startsWith(normalizedStopAt)
    && path.resolve(currentPath) !== normalizedStopAt
  ) {
    if (!fs.existsSync(currentPath)) {
      currentPath = path.dirname(currentPath);
      continue;
    }

    const stat = fs.lstatSync(currentPath);
    if (!stat.isDirectory() || fs.readdirSync(currentPath).length > 0) {
      break;
    }

    fs.rmdirSync(currentPath);
    currentPath = path.dirname(currentPath);
  }
}

// One target's uninstall result.
function uninstallResult(record, status, { removedPaths = [], plannedRemovals = [], keptPaths = [], error = null } = {}) {
  return { adapter: record.adapter, status, installStatePath: record.installStatePath, removedPaths, plannedRemovals, keptPaths, error };
}

// What the other installs in the same tree still record as their own copies.
// codex-home, goose-home and openhands-home all install into ~/.agents, each
// under its own install-state, so uninstalling one of them must leave the
// files the others still use. The sibling states are read when each target
// is uninstalled, not once up front: in a run that removes several targets
// the earlier ones have already dropped their state, and the last to leave
// takes the shared files with it. A dry run removes no state, so the states
// it has already planned to remove are passed in as departed and count as
// gone. A sibling state that cannot be read may still own any of them, so it
// is named instead of guessed at. Files are compared by their key, so a file
// two install-states record in two ways is still the same file; folding the
// letter case on a volume that tells it apart can only keep a file, never
// remove one.
function siblingOwnership(record, context, departed) {
  const adapter = listInstallTargetAdapters().find(candidate => candidate.id === record.adapter.id);
  if (!adapter) {
    return { owned: new Set(), unreadable: null };
  }
  const statePaths = collectSiblingInstallStatePaths(adapter, {
    homeDir: context.homeDir,
    projectRoot: context.projectRoot,
    repoRoot: context.projectRoot,
  }).filter(statePath => !departed.has(fileKey(statePath)));
  const owned = collectSiblingOwnedDestinations(statePaths);
  if (!owned) {
    const unreadable = statePaths.find(statePath => readInstallStateOrNull(statePath) === UNREADABLE_STATE);
    return { owned: new Set(), unreadable: unreadable || statePaths[0] };
  }
  return { owned: new Set(Array.from(owned, fileKey)), unreadable: null };
}

// What uninstalling one target would remove and what it would leave, or the
// reason the target is refused.
function planRecordUninstall(record, context, departed) {
  if (record.error || !record.state) {
    return { error: record.error || 'No valid install-state available' };
  }

  const operations = getManagedOperations(record.state);
  // Every recorded path is checked against the roots the adapter derives
  // today before anything is removed; one planted entry refuses the target.
  const escaping = findEscapingOperation(operations, record, context);
  if (escaping) {
    return { error: `Recorded operation escapes the managed roots for ${record.adapter.id}: ${escaping.destinationPath}` };
  }

  const siblings = siblingOwnership(record, context, departed);
  if (siblings.unreadable) {
    return { error: `Another install in the same tree has an install-state that cannot be read, so the files it still uses are unknown: ${siblings.unreadable}. Repair or remove that file, then uninstall again.` };
  }

  const isKept = operation => operation.kind === 'copy-file' && siblings.owned.has(fileKey(operation.destinationPath));
  const removable = operations.filter(operation => !isKept(operation));
  return {
    removable,
    keptPaths: Array.from(new Set(operations.filter(isKept).map(operation => operation.destinationPath))),
    plannedRemovals: Array.from(new Set([
      ...removable.map(operation => operation.destinationPath),
      record.installStatePath,
    ])),
  };
}

function removeRecordedInstall(record, operations) {
  const removedPaths = [];
  const cleanupTargets = [];

  for (const operation of operations) {
    const outcome = executeUninstallOperation(operation);
    removedPaths.push(...outcome.removedPaths);
    cleanupTargets.push(...outcome.cleanupTargets);
  }

  if (fs.existsSync(record.installStatePath)) {
    fs.rmSync(record.installStatePath, { force: true });
    removedPaths.push(record.installStatePath);
    cleanupTargets.push(record.installStatePath);
  }

  for (const cleanupTarget of cleanupTargets) {
    cleanupEmptyParentDirs(cleanupTarget, record.targetRoot);
  }

  return removedPaths;
}

function uninstallInstalledStates(options = {}) {
  const context = lifecycleRoots(options);
  const records = existingInstallStates(context.homeDir, context.projectRoot, options.targets);

  const departed = new Set();
  const results = records.map(record => {
    const plan = planRecordUninstall(record, context, departed);
    if (plan.error) {
      return uninstallResult(record, 'error', { error: plan.error });
    }
    const { keptPaths, plannedRemovals } = plan;

    if (options.dryRun) {
      departed.add(fileKey(record.installStatePath));
      return uninstallResult(record, 'planned', { plannedRemovals, keptPaths });
    }

    try {
      return uninstallResult(record, 'uninstalled', { removedPaths: removeRecordedInstall(record, plan.removable), keptPaths });
    } catch (error) {
      return uninstallResult(record, 'error', { plannedRemovals, keptPaths, error: error.message });
    }
  });

  const summary = results.reduce((accumulator, result) => ({
    checkedCount: accumulator.checkedCount + 1,
    uninstalledCount: accumulator.uninstalledCount + (result.status === 'uninstalled' ? 1 : 0),
    plannedRemovalCount: accumulator.plannedRemovalCount + (result.status === 'planned' ? 1 : 0),
    errorCount: accumulator.errorCount + (result.status === 'error' ? 1 : 0),
  }), {
    checkedCount: 0,
    uninstalledCount: 0,
    plannedRemovalCount: 0,
    errorCount: 0,
  });

  return {
    dryRun: Boolean(options.dryRun),
    generatedAt: new Date().toISOString(),
    results,
    summary,
  };
}

module.exports = {
  uninstallInstalledStates,
};
