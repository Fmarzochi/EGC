'use strict';

// Health inspection of managed operations: one verdict per recorded operation and per shared destination.
// Part of the install-lifecycle.js split; that file re-exports the public surface.

const fs = require('node:fs');
const { HOOK_OPERATION_KIND, resolveHookOperationHandlers } = require('./claude-settings-hooks');
const { MERGE_YAML_READ_LIST_KIND, mergeAiderConfigReadList } = require('./aider-config-merge');
const { MERGE_MARKDOWN_INDEX_KIND, nextSkillIndexContent } = require('./warp-agents-merge');
const {
  GENERATE_CONTEXT_FILE_KIND,
  hasProjectMemorySection,
} = require('./generated-context-files');
const {
  resolveOperationSourcePath,
  areFilesEqual,
  areFilesEqualAfterTransform,
  readFileUtf8,
  getOperationJsonPayload,
  readJsonFile,
  jsonContainsSubset,
} = require('./install-lifecycle-core');

function inspectResult(status, operation, destinationPath, extra = {}) {
  return { status, operation, destinationPath, ...extra };
}

function inspectRemoveOperation(operation, destinationPath) {
  if (fs.existsSync(destinationPath)) {
    return inspectResult('drifted', operation, destinationPath);
  }
  return inspectResult('ok', operation, destinationPath);
}

function inspectCopyFileOperation(repoRoot, operation, destinationPath) {
  const sourcePath = resolveOperationSourcePath(repoRoot, operation);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return inspectResult('missing-source', operation, destinationPath, { sourcePath });
  }
  const equal = operation.transform
    ? areFilesEqualAfterTransform(sourcePath, destinationPath, operation.transform)
    : areFilesEqual(sourcePath, destinationPath);
  if (!equal) {
    return inspectResult('drifted', operation, destinationPath, { sourcePath });
  }
  return inspectResult('ok', operation, destinationPath, { sourcePath });
}

function inspectMergeJsonOperation(operation, destinationPath) {
  const payload = getOperationJsonPayload(operation);
  if (payload === undefined) {
    return inspectResult('unverified', operation, destinationPath);
  }
  try {
    const currentValue = readJsonFile(destinationPath);
    if (!jsonContainsSubset(currentValue, payload)) {
      return inspectResult('drifted', operation, destinationPath);
    }
  } catch (_error) { // NOSONAR
    // ignore: parsing or merge failure means the content has drifted from expected schema
    return inspectResult('drifted', operation, destinationPath);
  }
  return inspectResult('ok', operation, destinationPath);
}

// Both Aider (YAML read-list) and Warp (markdown skill-index) merges are
// idempotent upserts: re-running the same merge against already-correct
// content reproduces that content unchanged. That makes drift detection a
// straight before/after comparison, without needing a second, parallel
// "is this entry present" implementation to keep in sync with the merge
// logic used for repair.
function inspectAiderConfigReadListOperation(operation, destinationPath) {
  if (!operation.readEntry) {
    return inspectResult('unverified', operation, destinationPath);
  }
  const existingContent = readFileUtf8(destinationPath);
  let nextContent;
  try {
    nextContent = mergeAiderConfigReadList(existingContent, operation.readEntry);
  } catch (_error) { // NOSONAR: merge failure is surfaced as drifted install state
    return inspectResult('drifted', operation, destinationPath);
  }
  if (nextContent !== existingContent) {
    return inspectResult('drifted', operation, destinationPath);
  }
  return inspectResult('ok', operation, destinationPath);
}

function inspectWarpAgentsIndexOperation(operation, destinationPath) {
  const existingContent = readFileUtf8(destinationPath);
  const nextContent = nextSkillIndexContent(existingContent, operation);
  if (nextContent !== null && nextContent !== existingContent) {
    return inspectResult('drifted', operation, destinationPath);
  }
  return inspectResult('ok', operation, destinationPath);
}

// Judged by structure, never by bytes: propagation fills the file after the
// install, and a byte comparison would report drift forever and let a
// repair wipe the projected memory.
function inspectGeneratedContextOperation(operation, destinationPath) {
  try {
    if (hasProjectMemorySection(readFileUtf8(destinationPath))) {
      return inspectResult('ok', operation, destinationPath);
    }
  } catch (_error) { // NOSONAR: a directory or an unreadable file in its place is drift, not a crash
    return inspectResult('drifted', operation, destinationPath);
  }
  return inspectResult('drifted', operation, destinationPath);
}

function inspectManagedOperation(repoRoot, operation) {
  const destinationPath = operation.destinationPath;
  if (!destinationPath) {
    return { status: 'invalid-destination', operation };
  }

  if (operation.kind === 'remove') {
    return inspectRemoveOperation(operation, destinationPath);
  }

  if (!fs.existsSync(destinationPath)) {
    return inspectResult('missing', operation, destinationPath);
  }

  if (operation.kind === 'copy-file') {
    return inspectCopyFileOperation(repoRoot, operation, destinationPath);
  }

  if (operation.kind === 'merge-json') {
    return inspectMergeJsonOperation(operation, destinationPath);
  }

  if (operation.kind === HOOK_OPERATION_KIND) {
    // Same lookup table uninstallManagedHookOperation and
    // applyManagedHookOperation use: which inspect function handles a given
    // hookEvent is resolved once, centrally, in claude-settings-hooks.js
    // (EGC-539 audit finding -- this file no longer re-enumerates all ~11
    // events on its own).
    const status = resolveHookOperationHandlers(operation.hookEvent).inspect(operation);
    return inspectResult(status, operation, destinationPath);
  }

  if (operation.kind === MERGE_YAML_READ_LIST_KIND) {
    return inspectAiderConfigReadListOperation(operation, destinationPath);
  }

  if (operation.kind === MERGE_MARKDOWN_INDEX_KIND) {
    return inspectWarpAgentsIndexOperation(operation, destinationPath);
  }

  if (operation.kind === GENERATE_CONTEXT_FILE_KIND) {
    return inspectGeneratedContextOperation(operation, destinationPath);
  }

  return inspectResult('unverified', operation, destinationPath);
}

// Install-states written before copy-file destinations were deduplicated at
// plan time can record several copy-file operations for one destination (two
// modules shipping the same file, e.g. a target's native tree and the
// flattened skill catalog). The file on disk can only ever match one source,
// so when ANY recorded owner matches, the destination is healthy and the
// other owners must not report it as drifted. When no owner matches, exactly
// one representative speaks for the destination, preferably one whose source
// still exists, so repair re-copies a single deterministic source and
// converges instead of ping-ponging between owners forever.
// A regular file only: an orphaned source path that survives as a DIRECTORY
// (a skill file reshaped into a folder across versions) must not be
// preferred, or repair's copyFileSync would fail on it while a sibling with
// a real file source sat unused.
function operationHasCopyableSource(repoRoot, operation) {
  const sourcePath = resolveOperationSourcePath(repoRoot, operation);
  if (!sourcePath) {
    return false;
  }
  try {
    return fs.statSync(sourcePath).isFile();
  } catch (_error) { // NOSONAR: an unreadable source is simply not preferable
    return false;
  }
}

function collapseSharedDestinationInspections(repoRoot, inspections) {
  const groupsByDestination = new Map();
  for (const inspection of inspections) {
    if (inspection.operation?.kind !== 'copy-file' || !inspection.destinationPath) {
      continue;
    }
    const group = groupsByDestination.get(inspection.destinationPath);
    if (group) {
      group.push(inspection);
    } else {
      groupsByDestination.set(inspection.destinationPath, [inspection]);
    }
  }

  const suppressed = new Set();
  for (const group of groupsByDestination.values()) {
    if (group.length < 2) {
      continue;
    }
    // Representative order: a matching owner proves the file healthy; then a
    // repairable owner whose source still exists (a missing destination
    // reports 'missing' for every owner without looking at sources, so an
    // orphaned first owner must not shadow a sibling repair could actually
    // copy from); then any repairable owner; then whatever is first.
    const keeper = group.find(inspection => inspection.status === 'ok')
      || group.find(inspection => (
        (inspection.status === 'drifted' || inspection.status === 'missing')
        && operationHasCopyableSource(repoRoot, inspection.operation)
      ))
      || group.find(inspection => inspection.status === 'drifted' || inspection.status === 'missing')
      || group[0];
    for (const inspection of group) {
      if (inspection !== keeper) {
        suppressed.add(inspection);
      }
    }
  }

  return inspections.filter(inspection => !suppressed.has(inspection));
}

function summarizeManagedOperationHealth(repoRoot, operations) {
  const inspections = collapseSharedDestinationInspections(
    repoRoot,
    operations.map(operation => inspectManagedOperation(repoRoot, operation))
  );

  return inspections.reduce((summary, inspection) => {
    if (inspection.status === 'missing') {
      summary.missing.push(inspection);
    } else if (inspection.status === 'drifted') {
      // Repair re-applies every drifted operation, hooks included; the doctor
      // reports a hook whose entry left the tool's config on its own, so the
      // hook inspections sit in both lists.
      summary.drifted.push(inspection);
      if (inspection.operation?.kind === HOOK_OPERATION_KIND) summary.missingHooks.push(inspection);
    } else if (inspection.status === 'missing-source') {
      summary.missingSource.push(inspection);
    } else if (inspection.status === 'unverified' || inspection.status === 'invalid-destination') {
      summary.unverified.push(inspection);
    }
    return summary;
  }, {
    missing: [],
    drifted: [],
    missingSource: [],
    unverified: [],
    missingHooks: [],
  });
}

module.exports = {
  summarizeManagedOperationHealth,
};
