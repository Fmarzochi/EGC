'use strict';

// Repair planning and execution for installed states.
// Part of the install-lifecycle.js split; that file re-exports the public surface.

const os = require('node:os');
const { writeInstallState } = require('./install-state');
const { fileKey } = require('./path-safety');
const { syncInstallStateToStore } = require('./install-state-store-sync');
const { createManifestInstallPlan } = require('./install-executor');
const {
  getManagedOperations,
  assertRecordedOperationsContained,
  operationIdentityKey,
} = require('./install-lifecycle-core');
const {
  hydrateRecordedOperations,
  buildRecordedStatePreview,
  shouldRepairFromRecordedOperations,
  executeRepairOperation,
} = require('./install-lifecycle-operations');
const { summarizeManagedOperationHealth } = require('./install-lifecycle-inspect');
const { manifestContext, existingInstallStates } = require('./install-lifecycle-doctor');

function createRepairPlanFromRecord(record, context) {
  const state = record.state;
  if (!state) {
    throw new Error('No install-state available for repair');
  }

  if (state.request.legacyMode || shouldRepairFromRecordedOperations(state)) {
    const operations = hydrateRecordedOperations(context.repoRoot, getManagedOperations(state));
    assertRecordedOperationsContained(record, context, operations);
    const statePreview = buildRecordedStatePreview(state, context, operations);

    // Roots come from the adapter (record), never from the state file.
    return {
      mode: state.request.legacyMode ? 'legacy' : 'recorded',
      target: record.adapter.target,
      adapter: record.adapter,
      targetRoot: record.targetRoot,
      installRoot: record.targetRoot,
      installStatePath: record.installStatePath,
      warnings: [],
      languages: Array.isArray(state.request.legacyLanguages)
        ? [...state.request.legacyLanguages]
        : [],
      operations,
      statePreview,
    };
  }

  const desiredPlan = createManifestInstallPlan({
    sourceRoot: context.repoRoot,
    target: record.adapter.target,
    profileId: state.request.profile || null,
    moduleIds: state.request.modules || [],
    includeComponentIds: state.request.includeComponents || [],
    excludeComponentIds: state.request.excludeComponents || [],
    projectRoot: context.projectRoot,
    homeDir: context.homeDir,
  });

  return {
    ...desiredPlan,
    statePreview: {
      ...desiredPlan.statePreview,
      installedAt: state.installedAt,
      lastValidatedAt: new Date().toISOString(),
    },
  };
}

function resolveRepairStatus(repairedCount, unrepairableCount) {
  if (unrepairableCount > 0) return repairedCount > 0 ? 'partial' : 'error';
  return repairedCount > 0 ? 'repaired' : 'ok';
}

// Two different problems land in the same list and must stay
// distinguishable: a source the reference repo no longer has, and an
// operation that failed while running (unwritable destination, permissions).
// The first keeps its original wording so the message stays familiar for the
// common case; the second reports what actually went wrong.
function describeUnrepairable(unrepairable) {
  if (unrepairable.length === 0) return null;

  const parts = [];
  const missingSources = unrepairable.filter(entry => entry.cause === 'missing-source');
  if (missingSources.length > 0) {
    parts.push(`Missing source file(s): ${missingSources.map(entry => entry.path).join(', ')}`);
  }
  for (const failure of unrepairable.filter(entry => entry.cause === 'failed')) {
    parts.push(`Unrepairable: ${failure.path} (${failure.reason})`);
  }
  return parts.join('; ');
}

// Drops the orphaned entries from the state that is about to be rewritten,
// so doctor converges to OK; the installed files stay on disk. This is the
// "source is gone" half of cleaning up after a renamed or dropped file: a
// recorded operation whose source the reference repo no longer has cannot
// be identity-checked, so repair only forgets it here. The "source is
// still there, just not part of the plan anymore" half, the common case
// for a rename, is handled separately by planGenericRetirements
// (install-targets/helpers.js), which the next install or auto-update
// runs and which does remove the file, after the same identity check
// (#1412).
function pruneOrphanedOperations(desiredPlan, orphanedInspections) {
  if (orphanedInspections.length === 0) return;
  const orphanKeys = new Set(orphanedInspections.map(entry => operationIdentityKey(entry.operation)));
  desiredPlan.statePreview.operations = desiredPlan.statePreview.operations.filter(
    operation => !orphanKeys.has(operationIdentityKey(operation))
  );
}

// Orphans and unfixable entries are worth reporting whether or not anything
// is being written: a dry run that says 'planned' or 'ok' while an entry can
// never be repaired is exactly the silence this reporting removes. Planned
// prunes count as planned work.
function buildDryRunRepairResult(record, { plannedRepairs, prunedPaths, unrepairable }) {
  const hasPlannedWork = plannedRepairs.length > 0 || prunedPaths.length > 0;
  let dryRunStatus = hasPlannedWork ? 'planned' : 'ok';
  if (unrepairable.length > 0) {
    dryRunStatus = hasPlannedWork ? 'partial' : 'error';
  }
  return {
    adapter: record.adapter,
    status: dryRunStatus,
    installStatePath: record.installStatePath,
    repairedPaths: [],
    plannedRepairs,
    prunedPaths: [],
    plannedPrunes: prunedPaths,
    unrepairable,
    stateRefreshed: plannedRepairs.length === 0,
    error: describeUnrepairable(unrepairable),
  };
}

// Each operation is executed on its own: one that cannot be carried out (its
// source was renamed away, or the destination is not writable) is recorded
// in `unrepairable` and the loop moves on, instead of throwing out and
// leaving every other managed file broken. Returns the repaired paths.
function executeRepairOperations(repoRoot, repairOperations, unrepairable) {
  const repairedPaths = [];
  for (const operation of repairOperations) {
    try {
      executeRepairOperation(repoRoot, operation);
      repairedPaths.push(operation.destinationPath);
    } catch (operationError) {
      // The destination, not the source: an execution failure is about the
      // file being written (permissions, a directory in the way), and naming
      // the source would point at a perfectly healthy file.
      unrepairable.push({
        path: operation.destinationPath,
        cause: 'failed',
        reason: operationError.message,
      });
    }
  }
  return repairedPaths;
}

// Repairs one discovered install-state record; the summary over all records
// is built by repairInstalledStates.
// The home whose store records a repair. A repair for the home of the
// process leaves the choice to the store, which honors EGC_DIR; a repair run
// for another home records the install in the store of that home.
function storeHomeFor(context) {
  const processHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return fileKey(context.homeDir) === fileKey(processHome) ? undefined : context.homeDir;
}

// The store sync of a repair, kept off the enumerable shape of its result so
// the JSON output stays as it is. Whoever repairs a home it is about to
// remove awaits it first.
function withSyncPromise(result, syncPromise) {
  Object.defineProperty(result, 'syncPromise', {
    value: syncPromise,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result;
}

function repairRecord(record, context, options) {
  if (record.error) {
    return {
      adapter: record.adapter,
      status: 'error',
      installStatePath: record.installStatePath,
      repairedPaths: [],
      plannedRepairs: [],
      error: record.error,
    };
  }

  try {
    const desiredPlan = createRepairPlanFromRecord(record, context);
    const operationHealth = summarizeManagedOperationHealth(context.repoRoot, desiredPlan.operations);

    // What a missing source means depends on where this plan came from.
    // A RECORDED plan (legacy states, or states carrying non-copy-file
    // operations) replays entries written by an older install, so a source
    // this reference repo no longer has is an orphan it can never satisfy
    // again (renamed away, dropped from the package, or synced from a
    // different checkout): the entry is pruned from the rewritten
    // install-state so doctor converges to OK, and the installed file is
    // left on disk untouched -- deleting it could break live wiring, like
    // a settings.json hook still pointing at that script. A MANIFEST plan
    // is recomputed from the current manifests, so a missing source there
    // means the manifest itself demands a file the package does not ship:
    // pruning would hide a packaging bug, and those stay unrepairable.
    // The recorded relative path, not the resolved absolute one: it is
    // what the install-state holds, so both the JSON output and the
    // printed lines stay identical across machines.
    const planIsRecorded = desiredPlan.mode === 'legacy' || desiredPlan.mode === 'recorded';
    const orphanedInspections = planIsRecorded ? operationHealth.missingSource : [];
    const prunedPaths = orphanedInspections.map(entry => (
      entry.operation?.sourceRelativePath || entry.sourcePath
    ));
    const unrepairable = (planIsRecorded ? [] : operationHealth.missingSource).map(entry => ({
      path: entry.operation?.sourceRelativePath || entry.sourcePath,
      cause: 'missing-source',
      reason: 'source file is no longer in the reference repo',
    }));

    pruneOrphanedOperations(desiredPlan, orphanedInspections);

    const repairOperations = [
      ...operationHealth.missing.map(entry => ({ ...entry.operation })),
      ...operationHealth.drifted.map(entry => ({ ...entry.operation })),
    ];
    const plannedRepairs = repairOperations.map(operation => operation.destinationPath);

    if (options.dryRun) {
      return buildDryRunRepairResult(record, { plannedRepairs, prunedPaths, unrepairable });
    }

    const repairedPaths = executeRepairOperations(context.repoRoot, repairOperations, unrepairable);

    writeInstallState(desiredPlan.installStatePath, desiredPlan.statePreview);

    const syncPromise = syncInstallStateToStore(desiredPlan.statePreview, {
      homeDir: storeHomeFor(context),
      onError: error => console.error(`Warning: Failed to sync install state to status store: ${error.message}`),
    });

    return withSyncPromise({
      adapter: record.adapter,
      // 'partial' when real work was done but something is still
      // unfixable: neither a clean success nor a total failure, and the
      // exit code keeps saying attention is needed. Pruning a stale entry
      // is real work: the rewritten install-state is what heals doctor.
      status: resolveRepairStatus(repairedPaths.length + prunedPaths.length, unrepairable.length),
      installStatePath: record.installStatePath,
      repairedPaths,
      plannedRepairs: [],
      prunedPaths,
      plannedPrunes: [],
      unrepairable,
      stateRefreshed: true,
      error: describeUnrepairable(unrepairable),
    }, syncPromise);
  } catch (error) {
    return {
      adapter: record.adapter,
      status: 'error',
      installStatePath: record.installStatePath,
      repairedPaths: [],
      plannedRepairs: [],
      error: error.message,
    };
  }
}

function repairInstalledStates(options = {}) {
  const { loaded, context } = manifestContext(options);
  const records = existingInstallStates(context.homeDir, context.projectRoot, options.targets);

  const results = records.map(record => (loaded.error
    ? { adapter: record.adapter, status: 'error', installStatePath: record.installStatePath, repairedPaths: [], plannedRepairs: [], error: `Install manifests refused: ${loaded.error}` }
    : repairRecord(record, context, options)));

  // 'partial' means work plus something unfixable, so it counts in both the
  // work column and the error column. Which work column depends on the mode:
  // a dry run planned repairs and wrote nothing, so counting it as repaired
  // would report writes that never happened.
  const dryRun = Boolean(options.dryRun);
  const summary = results.reduce((accumulator, result) => ({
    checkedCount: accumulator.checkedCount + 1,
    repairedCount: accumulator.repairedCount
      + (!dryRun && (result.status === 'repaired' || result.status === 'partial') ? 1 : 0),
    plannedRepairCount: accumulator.plannedRepairCount
      + (result.status === 'planned' || (dryRun && result.status === 'partial') ? 1 : 0),
    errorCount: accumulator.errorCount + (result.status === 'error' || result.status === 'partial' ? 1 : 0),
    unrepairableCount: accumulator.unrepairableCount + (result.unrepairable?.length || 0),
    prunedCount: accumulator.prunedCount + (result.prunedPaths?.length || 0),
    plannedPruneCount: accumulator.plannedPruneCount + (result.plannedPrunes?.length || 0),
  }), {
    checkedCount: 0,
    repairedCount: 0,
    plannedRepairCount: 0,
    // A refused manifest with no record to carry it is still an error.
    errorCount: loaded.error && results.length === 0 ? 1 : 0,
    unrepairableCount: 0,
    prunedCount: 0,
    plannedPruneCount: 0,
  });

  return withSyncPromise({
    dryRun: Boolean(options.dryRun),
    generatedAt: new Date().toISOString(),
    manifestError: loaded.error,
    results,
    summary,
  }, Promise.all(results.map(result => result.syncPromise)));
}

module.exports = {
  repairInstalledStates,
};
