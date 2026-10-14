'use strict';

const { writeInstallState } = require('../install-state');
const { syncInstallStateToStore } = require('../install-state-store-sync');
const { isMcpConfigPath, parseDisabledMcpServers } = require('../mcp-config');
const { copyFileKeepingMode, writeTextKeepingMode } = require('./preserving-write');
const { plannedFileContent } = require('./copy-transforms');
const { deepMergeJson } = require('../json-merge');
const { HOOK_OPERATION_KIND, applyManagedHookOperation } = require('../claude-settings-hooks');
const { MERGE_YAML_READ_LIST_KIND } = require('../aider-config-merge');
const { MERGE_MARKDOWN_INDEX_KIND } = require('../warp-agents-merge');
const { GENERATE_CONTEXT_FILE_KIND } = require('../generated-context-files');
const fs = require('node:fs');
const path = require('node:path');
const { refuseLinkedDestination, segments } = require('./apply-link-safety');
const { applyMergeJsonOperation, applyMergeYamlReadListOperation, applyMergeMarkdownIndexOperation, applyGeneratedContextOperation, applyMcpCopyFileOperation, writeGuardianCliMarker, writeManagedText } = require('./apply-operations');
const { retirePlannedFiles, managedRootFor, retirableFiles, retirableHooks, predictEmptiedHooksFiles, retirableEmptiedHooksFiles, removeEmptiedHooksFiles, retirePlannedHooks, sha256, removeLegacyInstallStates } = require('./apply-retirement');
const { checkedDestinations, findLegacyLinks, findStrandedLegacyLinks, removeStrandedLegacyLinks, recordWrittenContentHashes, removeLegacyLinks } = require('./apply-legacy-links');
const { collectShapeTransitions, formatShapeTransitionsRefusal, performShapeTransitions } = require('./apply-shape-transitions');

function applyGeneratedContextRecordingHash(operation, writtenHashes) {
  const landed = applyGeneratedContextOperation(operation);
  if (landed !== null) writtenHashes.set(path.resolve(operation.destinationPath), sha256(Buffer.from(landed, 'utf8')));
}

// One planned operation, by kind: the merge and hook kinds edit a file in
// place, a generated context file is written only when it lacks its
// section, and a copied file lands with its hash recorded for the state.
function applyPlannedOperation(operation, disabledServers, writtenHashes) {
  if (operation.kind === HOOK_OPERATION_KIND) {
    applyManagedHookOperation(operation);
  } else if (operation.kind === 'merge-json') {
    applyMergeJsonOperation(operation, disabledServers);
  } else if (operation.kind === MERGE_YAML_READ_LIST_KIND) {
    applyMergeYamlReadListOperation(operation);
  } else if (operation.kind === MERGE_MARKDOWN_INDEX_KIND) {
    applyMergeMarkdownIndexOperation(operation);
  } else if (operation.kind === GENERATE_CONTEXT_FILE_KIND) {
    applyGeneratedContextRecordingHash(operation, writtenHashes);
  } else if (operation.kind === 'copy-file' && isMcpConfigPath(operation.destinationPath)) {
    const landed = applyMcpCopyFileOperation(operation, disabledServers);
    writtenHashes.set(path.resolve(operation.destinationPath), sha256(Buffer.from(landed, 'utf8')));
  } else if (operation.kind === 'copy-file' && operation.transform) {
    const landed = plannedFileContent(operation.sourcePath, operation.transform).toString('utf8');
    writeTextKeepingMode(operation.destinationPath, landed, operation.sourcePath);
    writtenHashes.set(path.resolve(operation.destinationPath), sha256(Buffer.from(landed, 'utf8')));
  } else {
    const source = operation.kind === 'copy-file' ? fs.readFileSync(operation.sourcePath) : null;
    copyFileKeepingMode(operation.sourcePath, operation.destinationPath);
    if (source) writtenHashes.set(path.resolve(operation.destinationPath), sha256(source));
  }
}

function applyInstallPlan(plan, { onWarning, homeDir, dbPath } = {}) {
  const disabledServers = parseDisabledMcpServers(process.env.EGC_DISABLED_MCPS || process.env.ECC_DISABLED_MCPS);

  // Shape transitions are resolved before the first write: a refusal throws
  // with the layout still untouched, so a source that changed shape between
  // installs fails clearly instead of hitting EEXIST mid-copy.
  const shapeResult = collectShapeTransitions(plan);
  if (shapeResult.refusals.length > 0) {
    throw new Error(formatShapeTransitionsRefusal(shapeResult.refusals));
  }
  plan.shapeTransitions = shapeResult.transitions;

  // A transition is only performed when the operation that will consume it is
  // reached: a dir-to-file right before the file write that replaces the
  // directory, a file-to-dir before the first child copy that needs it. A
  // failure in an earlier operation then leaves the old layout in place
  // instead of deleting it and never replacing it.
  const pendingTransitions = new Map(
    (plan.shapeTransitions || []).map(transition => [path.resolve(transition.destinationPath), transition])
  );
  const performPendingTransitionsFor = destinationPath => {
    const resolved = path.resolve(destinationPath);
    const due = [];
    for (const [target, transition] of pendingTransitions) {
      if (resolved === target || resolved.startsWith(target + path.sep)) due.push(transition);
    }
    if (due.length === 0) return;
    due.sort((a, b) => segments(b.destinationPath) - segments(a.destinationPath));
    for (const transition of due) {
      performShapeTransitions([transition], plan);
      pendingTransitions.delete(path.resolve(transition.destinationPath));
    }
  };

  // Every destination is checked before the first write, the state file and
  // the hooks file included, so a planted link fails the install before it
  // changes anything. Links that are EGC's own legacy layout (#1400) are
  // collected in that same pass and only removed once every path has
  // passed: a refusal further down never leaves a skill half migrated.
  // The per-destination check below then runs as before; a link swapped in
  // after this point is refused like any other.
  const migratedLegacyLinks = findLegacyLinks(plan, { strict: true });
  removeLegacyLinks(migratedLegacyLinks, plan.targetRoot);
  refuseLinkedDestination(plan.installStatePath, plan.targetRoot);
  const writtenHashes = new Map();
  for (const operation of plan.operations) {

    refuseLinkedDestination(operation.destinationPath, managedRootFor(plan, operation.destinationPath));
    performPendingTransitionsFor(operation.destinationPath);

    fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });


    applyPlannedOperation(operation, disabledServers, writtenHashes);
  }

  // A listed transition always has its consuming operation; a transition
  // still pending here could not have been reached by the loop and is
  // resolved so the report matches the disk.
  performShapeTransitions([...pendingTransitions.values()], plan);

  const retiredFiles = retirePlannedFiles(plan);
  const emptiedHooksFiles = predictEmptiedHooksFiles(plan.hookRetirements);
  const retiredHooks = retirePlannedHooks(plan);
  const removedHooksFiles = removeEmptiedHooksFiles(emptiedHooksFiles);
  const retiredLegacyLinks = removeStrandedLegacyLinks(findStrandedLegacyLinks(plan), plan.targetRoot);

  recordWrittenContentHashes(plan, writtenHashes);
  writeInstallState(plan.installStatePath, plan.statePreview);
  removeLegacyInstallStates(plan);

  writeGuardianCliMarker(onWarning, homeDir);

  // Capture the async promise so callers (e.g. install() in the operations
  // registry) can await it before restoring console.error, ensuring that the
  // onError callback fires while any console intercept is still in place.
  // The promise is attached as a non-enumerable property so it never appears
  // in JSON.stringify() output (e.g. egc install --json).
  const syncPromise = syncInstallStateToStore(plan.statePreview, {
    homeDir,
    dbPath,
    onError: error => {
      const msg = `Warning: Failed to sync install state to status store: ${error.message}`;
      if (typeof onWarning === 'function') {
        onWarning(msg);
      } else {
        console.error(msg);
      }
    },
  });

  const result = { ...plan, applied: true, migratedLegacyLinks, retiredLegacyLinks, retiredFiles, retiredHooks, removedHooksFiles, shapeTransitions: shapeResult.transitions };
  Object.defineProperty(result, 'syncPromise', {
    value: syncPromise,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result;
}

module.exports = {
  applyInstallPlan,
  managedRootFor,
  retirableEmptiedHooksFiles,
  retirableFiles,
  retirableHooks,
  retirePlannedFiles,
  checkedDestinations,
  deepMergeJson,
  findLegacyLinks,
  findStrandedLegacyLinks,
  refuseLinkedDestination,
  removeLegacyLinks,
  writeGuardianCliMarker,
  writeManagedText,
  collectShapeTransitions,
  performShapeTransitions,
  formatShapeTransitionsRefusal,
};
