const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveInstallPlan, loadInstallManifests } = require('./install-manifests');
const { readInstallState, writeInstallState } = require('./install-state');
const { syncInstallStateToStore } = require('./install-state-store-sync');
const {
  createManifestInstallPlan,
} = require('./install-executor');
const {
  getInstallTargetAdapter,
  listInstallTargetAdapters,
} = require('./install-targets/registry');
const {
  HOOK_OPERATION_KIND,
  applyManagedHookOperation,
  resolveHookOperationHandlers,
} = require('./claude-settings-hooks');
const {
  MERGE_YAML_READ_LIST_KIND,
  REMOVE_SENTINEL: AIDER_REMOVE_SENTINEL,
  mergeAiderConfigReadList,
  removeAiderConfigReadEntry,
} = require('./aider-config-merge');
const {
  MERGE_MARKDOWN_INDEX_KIND,
  mergeSkillIndexEntry,
  removeSkillIndexEntry,
} = require('./warp-agents-merge');

const DEFAULT_REPO_ROOT = path.join(__dirname, '../..');

function readPackageVersion(repoRoot) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return packageJson.version || null;
  } catch (_error) { // NOSONAR: unreadable package.json means unknown version
    return null;
  }
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    // Five targets ship home+project adapter pairs under one target id
    // (kiro, junie, amp, windsurf, openhands); mapping adapters straight to
    // target ids repeated those ids and made doctor/repair examine the same
    // home install-state twice per run.
    const defaultTargets = [];
    for (const adapter of listInstallTargetAdapters()) {
      if (!defaultTargets.includes(adapter.target)) {
        defaultTargets.push(adapter.target);
      }
    }
    return defaultTargets;
  }

  const normalizedTargets = [];
  for (const target of targets) {
    const adapter = getInstallTargetAdapter(target);
    if (!normalizedTargets.includes(adapter.target)) {
      normalizedTargets.push(adapter.target);
    }
  }

  return normalizedTargets;
}

function compareStringArrays(left, right) {
  const leftValues = Array.isArray(left) ? left : [];
  const rightValues = Array.isArray(right) ? right : [];

  if (leftValues.length !== rightValues.length) {
    return false;
  }

  return leftValues.every((value, index) => value === rightValues[index]);
}

function getManagedOperations(state) {
  return Array.isArray(state?.operations)
    ? state.operations.filter(operation => operation.ownership === 'managed')
    : [];
}

function hasParentSegment(value) {
  return String(value).split(/[\\/]/).includes('..');
}

// Only the manifest-relative path recorded at install time is joined onto
// the reference repository; the absolute sourcePath stored next to it is
// never replayed, so a planted entry cannot make repair copy from anywhere.
function resolveOperationSourcePath(repoRoot, operation) {
  const relative = operation.sourceRelativePath;
  if (typeof relative !== 'string' || relative.trim() === '' || path.isAbsolute(relative) || hasParentSegment(relative)) {
    return null;
  }
  return path.join(repoRoot, relative);
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Destinations this adapter would produce today, derived from the current
// manifest rather than read back from the state file. The recorded request
// is tried first; a request the manifest can no longer plan falls back to the
// full profile, and with no plan at all only the derived target root counts.
function collectPlannedDestinations(record, context) {
  const request = record.state?.request || {};
  const attempts = [
    { profileId: request.profile || null, moduleIds: request.modules || [], includeComponentIds: request.includeComponents || [], excludeComponentIds: request.excludeComponents || [] },
    { profileId: 'full', moduleIds: [], includeComponentIds: [], excludeComponentIds: [] },
  ];
  for (const attempt of attempts) {
    try {
      const plan = createManifestInstallPlan({
        sourceRoot: context.repoRoot,
        target: record.adapter.target,
        projectRoot: context.projectRoot,
        homeDir: context.homeDir,
        ...attempt,
      });
      const operations = Array.isArray(plan.operations) ? plan.operations : [];
      return {
        files: new Set(operations.map(operation => path.resolve(operation.destinationPath))),
        dirs: new Set(operations.filter(operation => operation.kind === 'copy-path').map(operation => path.resolve(operation.destinationPath))),
      };
    } catch (_error) { // NOSONAR: a request the current manifest cannot plan falls through to the next attempt
      continue;
    }
  }
  return { files: new Set(), dirs: new Set() };
}

// A recorded operation may only touch the derived target root, a file the
// current manifest plans for this adapter, or a directory that plan copies.
function operationEscapes(operation, root, planned) {
  const destination = operation.destinationPath;
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || hasParentSegment(destination)) return true;
  const resolved = path.resolve(destination);
  if (operation.kind === 'remove' && resolved === root) return true;
  if (isPathInside(resolved, root)) return false;
  if (planned.files.has(resolved)) return false;
  return ![...planned.dirs].some(dir => isPathInside(resolved, dir));
}

function findEscapingOperation(operations, record, context) {
  const root = path.resolve(record.targetRoot);
  const planned = collectPlannedDestinations(record, context);
  return operations.find(operation => operationEscapes(operation, root, planned)) || null;
}

function assertRecordedOperationsContained(record, context, operations) {
  const escaping = findEscapingOperation(operations, record, context);
  if (escaping) {
    throw new Error(`Recorded operation escapes the managed roots for ${record.adapter.id}: ${escaping.destinationPath}`);
  }
}

// Identity for matching a health inspection back to the operation entry in a
// rewritten state preview: the two hold distinct object copies of the same
// recorded operation, so matching is by content, not reference.
function operationIdentityKey(operation) {
  const source = String(operation?.sourceRelativePath || operation?.sourcePath || '').replaceAll('\\', '/');
  const destination = String(operation?.destinationPath || '').replaceAll('\\', '/');
  return `${operation?.kind}|${source}|${destination}`;
}

function areFilesEqual(leftPath, rightPath) {
  try {
    const leftStat = fs.statSync(leftPath);
    const rightStat = fs.statSync(rightPath);
    if (!leftStat.isFile() || !rightStat.isFile()) {
      return false;
    }

    const left = fs.readFileSync(leftPath);
    const right = fs.readFileSync(rightPath);
    if (left.equals(right)) {
      return true;
    }

    // A byte mismatch that disappears once CRLF/LF are normalized is a
    // line-ending artifact of the install pipeline (e.g. Windows
    // core.autocrlf rewriting the repo's LF source on checkout, or a
    // rewrite step like buildResolvedClaudeHooks() that always emits LF via
    // JSON.stringify), not a real edit to the managed file -- never flag it
    // as drift.
    return left.toString('utf8').replaceAll('\r\n', '\n') === right.toString('utf8').replaceAll('\r\n', '\n');
  } catch (_error) { // NOSONAR: unreadable files are treated as different
    return false;
  }
}

function readFileUtf8(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.codePointAt(0) === 0xFEFF ? content.slice(1) : content;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value) {
  if (value === undefined) {
    return undefined;
  }

  return structuredClone(value);
}

function parseJsonLikeValue(value, label) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new Error(`Invalid ${label}: ${error.message}`, { cause: error });
    }
  }

  if (value === null || Array.isArray(value) || isPlainObject(value) || typeof value === 'number' || typeof value === 'boolean') {
    return cloneJsonValue(value);
  }

  throw new Error(`Invalid ${label}: expected JSON-compatible data`);
}

function getOperationJsonPayload(operation) {
  const candidateKeys = [
    'mergePayload',
    'managedPayload',
    'payload',
    'value',
    'expectedValue',
  ];

  for (const key of candidateKeys) {
    if (operation[key] !== undefined) {
      return parseJsonLikeValue(operation[key], `${operation.kind}.${key}`);
    }
  }

  return undefined;
}

function getOperationPreviousContent(operation) {
  const candidateKeys = [
    'previousContent',
    'originalContent',
    'backupContent',
  ];

  for (const key of candidateKeys) {
    if (typeof operation[key] === 'string') {
      return operation[key];
    }
  }

  return null;
}

function getOperationPreviousJson(operation) {
  const candidateKeys = [
    'previousValue',
    'previousJson',
    'originalValue',
  ];

  for (const key of candidateKeys) {
    if (operation[key] !== undefined) {
      return parseJsonLikeValue(operation[key], `${operation.kind}.${key}`);
    }
  }

  return undefined;
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJsonFile(filePath) {
  return JSON.parse(readFileUtf8(filePath));
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function deepMergeJson(baseValue, patchValue) {
  if (!isPlainObject(baseValue) || !isPlainObject(patchValue)) {
    return cloneJsonValue(patchValue);
  }

  const merged = { ...baseValue };
  for (const [key, value] of Object.entries(patchValue)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = deepMergeJson(merged[key], value);
    } else {
      merged[key] = cloneJsonValue(value);
    }
  }
  return merged;
}

function jsonContainsSubset(actualValue, expectedValue) {
  if (isPlainObject(expectedValue)) {
    if (!isPlainObject(actualValue)) {
      return false;
    }

    return Object.entries(expectedValue).every(([key, value]) => (
      Object.hasOwn(actualValue, key)
      && jsonContainsSubset(actualValue[key], value)
    ));
  }

  if (Array.isArray(expectedValue)) {
    if (!Array.isArray(actualValue) || actualValue.length !== expectedValue.length) {
      return false;
    }

    return expectedValue.every((item, index) => jsonContainsSubset(actualValue[index], item));
  }

  return actualValue === expectedValue;
}

const JSON_REMOVE_SENTINEL = Symbol('json-remove');

function handleNestedPlainObjectRemove(nextValue, key, value) {
  const nestedValue = deepRemoveJsonSubset(nextValue[key], value);
  if (nestedValue === JSON_REMOVE_SENTINEL) {
    delete nextValue[key];
  } else {
    nextValue[key] = nestedValue;
  }
}

function handleNestedArrayRemove(nextValue, key, value) {
  if (Array.isArray(nextValue[key]) && jsonContainsSubset(nextValue[key], value)) {
    delete nextValue[key];
  }
}

function removePlainObjectSubset(currentValue, managedValue) {
  if (!isPlainObject(currentValue)) {
    return currentValue;
  }

  const nextValue = { ...currentValue };
  for (const [key, value] of Object.entries(managedValue)) {
    if (!Object.hasOwn(nextValue, key)) {
      continue;
    }

    if (isPlainObject(value)) {
      handleNestedPlainObjectRemove(nextValue, key, value);
    } else if (Array.isArray(value)) {
      handleNestedArrayRemove(nextValue, key, value);
    } else if (nextValue[key] === value) {
      delete nextValue[key];
    }
  }

  return Object.keys(nextValue).length === 0 ? JSON_REMOVE_SENTINEL : nextValue;
}

function deepRemoveJsonSubset(currentValue, managedValue) {
  if (isPlainObject(managedValue)) {
    return removePlainObjectSubset(currentValue, managedValue);
  }

  if (Array.isArray(managedValue)) {
    return jsonContainsSubset(currentValue, managedValue) ? JSON_REMOVE_SENTINEL : currentValue;
  }

  return currentValue === managedValue ? JSON_REMOVE_SENTINEL : currentValue;
}

function hydrateRecordedOperations(repoRoot, operations) {
  return operations.map(operation => {
    if (operation.kind !== 'copy-file') {
      return { ...operation };
    }

    return {
      ...operation,
      sourcePath: resolveOperationSourcePath(repoRoot, operation),
    };
  });
}

function buildRecordedStatePreview(state, context, operations) {
  return {
    ...state,
    operations: operations.map(operation => ({ ...operation })),
    source: {
      ...state.source,
      repoVersion: context.packageVersion,
      manifestVersion: context.manifestVersion,
    },
    lastValidatedAt: new Date().toISOString(),
  };
}

function shouldRepairFromRecordedOperations(state) {
  return getManagedOperations(state).some(operation => operation.kind !== 'copy-file');
}

function repairCopyFile(repoRoot, operation) {
  const sourcePath = resolveOperationSourcePath(repoRoot, operation);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`Missing source file for repair: ${sourcePath || operation.sourceRelativePath}`);
  }

  ensureParentDir(operation.destinationPath);
  fs.copyFileSync(sourcePath, operation.destinationPath);
}

function repairMergeJson(operation) {
  const payload = getOperationJsonPayload(operation);
  if (payload === undefined) {
    throw new Error(`Missing merge payload for repair: ${operation.destinationPath}`);
  }

  const currentValue = fs.existsSync(operation.destinationPath)
    ? readJsonFile(operation.destinationPath)
    : {};
  const mergedValue = deepMergeJson(currentValue, payload);

  ensureParentDir(operation.destinationPath);
  fs.writeFileSync(operation.destinationPath, formatJson(mergedValue));
}

function repairRemove(operation) {
  if (!fs.existsSync(operation.destinationPath)) {
    return;
  }

  fs.rmSync(operation.destinationPath, { recursive: true, force: true });
}

function repairMergeYamlReadList(operation) {
  if (!operation.readEntry) {
    throw new Error(`Missing readEntry for repair: ${operation.destinationPath}`);
  }
  const existingContent = fs.existsSync(operation.destinationPath)
    ? fs.readFileSync(operation.destinationPath, 'utf8')
    : null;
  let nextContent;
  try {
    nextContent = mergeAiderConfigReadList(existingContent, operation.readEntry);
  } catch (error) {
    throw new Error(
      `Failed to parse Aider config at ${operation.destinationPath}: ${error.message}`,
      { cause: error },
    );
  }
  ensureParentDir(operation.destinationPath);
  fs.writeFileSync(operation.destinationPath, nextContent);
}

function repairMergeMarkdownIndex(operation) {
  const existingContent = fs.existsSync(operation.destinationPath)
    ? fs.readFileSync(operation.destinationPath, 'utf8')
    : null;
  const nextContent = mergeSkillIndexEntry(existingContent, {
    name: operation.skillName,
    description: operation.skillDescription,
    relativePath: operation.relativePath,
  });
  ensureParentDir(operation.destinationPath);
  fs.writeFileSync(operation.destinationPath, nextContent);
}

function executeRepairOperation(repoRoot, operation) {
  if (operation.kind === 'copy-file') {
    repairCopyFile(repoRoot, operation);
  } else if (operation.kind === 'merge-json') {
    repairMergeJson(operation);
  } else if (operation.kind === 'remove') {
    repairRemove(operation);
  } else if (operation.kind === HOOK_OPERATION_KIND) {
    applyManagedHookOperation(operation);
  } else if (operation.kind === MERGE_YAML_READ_LIST_KIND) {
    repairMergeYamlReadList(operation);
  } else if (operation.kind === MERGE_MARKDOWN_INDEX_KIND) {
    repairMergeMarkdownIndex(operation);
  } else {
    throw new Error(`Unsupported repair operation kind: ${operation.kind}`);
  }
}

function restorePreviousContent(operation) {
  const previousContent = getOperationPreviousContent(operation);
  if (previousContent !== null) {
    ensureParentDir(operation.destinationPath);
    fs.writeFileSync(operation.destinationPath, previousContent);
    return { removedPaths: [], cleanupTargets: [] };
  }

  const previousJson = getOperationPreviousJson(operation);
  if (previousJson !== undefined) {
    ensureParentDir(operation.destinationPath);
    fs.writeFileSync(operation.destinationPath, formatJson(previousJson));
    return { removedPaths: [], cleanupTargets: [] };
  }

  return null;
}

function uninstallCopyFile(operation) {
  if (!fs.existsSync(operation.destinationPath)) {
    return { removedPaths: [], cleanupTargets: [] };
  }
  fs.rmSync(operation.destinationPath, { force: true });
  return {
    removedPaths: [operation.destinationPath],
    cleanupTargets: [operation.destinationPath],
  };
}

function uninstallMergeJson(operation) {
  const restored = restorePreviousContent(operation);
  if (restored) return restored;

  if (!fs.existsSync(operation.destinationPath)) {
    return { removedPaths: [], cleanupTargets: [] };
  }

  const payload = getOperationJsonPayload(operation);
  if (payload === undefined) {
    throw new Error(`Missing merge payload for uninstall: ${operation.destinationPath}`);
  }

  const currentValue = readJsonFile(operation.destinationPath);
  const nextValue = deepRemoveJsonSubset(currentValue, payload);
  if (nextValue === JSON_REMOVE_SENTINEL) {
    fs.rmSync(operation.destinationPath, { force: true });
    return {
      removedPaths: [operation.destinationPath],
      cleanupTargets: [operation.destinationPath],
    };
  }

  ensureParentDir(operation.destinationPath);
  fs.writeFileSync(operation.destinationPath, formatJson(nextValue));
  return { removedPaths: [], cleanupTargets: [] };
}

function uninstallRemove(operation) {
  const restored = restorePreviousContent(operation);
  if (restored) return restored;
  return { removedPaths: [], cleanupTargets: [] };
}

function uninstallAiderConfigReadList(operation) {
  // Strips only the EGC-added read: entry. .aider.conf.yml is only deleted
  // if EGC's entry was the last thing keeping it non-empty -- the user's own
  // model settings, lint commands, etc are never touched.
  if (!operation.readEntry || !fs.existsSync(operation.destinationPath)) {
    return { removedPaths: [], cleanupTargets: [] };
  }

  const existingContent = fs.readFileSync(operation.destinationPath, 'utf8');
  const nextContent = removeAiderConfigReadEntry(existingContent, operation.readEntry);
  if (nextContent === AIDER_REMOVE_SENTINEL) {
    fs.rmSync(operation.destinationPath, { force: true });
    return {
      removedPaths: [operation.destinationPath],
      cleanupTargets: [operation.destinationPath],
    };
  }

  ensureParentDir(operation.destinationPath);
  fs.writeFileSync(operation.destinationPath, nextContent);
  return { removedPaths: [], cleanupTargets: [] };
}

function uninstallWarpAgentsIndexEntry(operation) {
  // Strips only the EGC-added index entry from the marked block. AGENTS.md
  // itself is never deleted, even if the block becomes empty -- it is an
  // increasingly common cross-tool convention file the user's other tools
  // may also rely on.
  if (!operation.skillName || !fs.existsSync(operation.destinationPath)) {
    return { removedPaths: [], cleanupTargets: [] };
  }

  const existingContent = fs.readFileSync(operation.destinationPath, 'utf8');
  const nextContent = removeSkillIndexEntry(existingContent, operation.skillName);
  ensureParentDir(operation.destinationPath);
  fs.writeFileSync(operation.destinationPath, nextContent);
  return { removedPaths: [], cleanupTargets: [] };
}

function uninstallManagedHookOperation(operation) {
  // Strips only the EGC-managed hook entry. The settings file itself is never
  // deleted because Claude Code and the user own its other keys. Which
  // remove function handles a given hookEvent is looked up from the same
  // apply/remove/inspect table claude-settings-hooks.js's
  // applyManagedHookOperation uses, instead of re-enumerating the same
  // ~11 events here (EGC-539 audit finding).
  resolveHookOperationHandlers(operation.hookEvent).remove(operation);
  return { removedPaths: [], cleanupTargets: [] };
}

const UNINSTALL_HANDLERS = {
  'copy-file': uninstallCopyFile,
  'merge-json': uninstallMergeJson,
  'remove': uninstallRemove,
  [HOOK_OPERATION_KIND]: uninstallManagedHookOperation,
  [MERGE_YAML_READ_LIST_KIND]: uninstallAiderConfigReadList,
  [MERGE_MARKDOWN_INDEX_KIND]: uninstallWarpAgentsIndexEntry,
};

function executeUninstallOperation(operation) {
  const handler = UNINSTALL_HANDLERS[operation.kind];
  if (!handler) {
    throw new Error(`Unsupported uninstall operation kind: ${operation.kind}`);
  }
  return handler(operation);
}

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
  if (!areFilesEqual(sourcePath, destinationPath)) {
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
  const nextContent = mergeSkillIndexEntry(existingContent, {
    name: operation.skillName,
    description: operation.skillDescription,
    relativePath: operation.relativePath,
  });
  if (nextContent !== existingContent) {
    return inspectResult('drifted', operation, destinationPath);
  }
  return inspectResult('ok', operation, destinationPath);
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
      summary.drifted.push(inspection);
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
  });
}

function buildDiscoveryRecord(adapter, context) {
  const installTargetInput = {
    homeDir: context.homeDir,
    projectRoot: context.projectRoot,
    repoRoot: context.projectRoot,
  };
  const targetRoot = adapter.resolveRoot(installTargetInput);
  const installStatePath = adapter.getInstallStatePath(installTargetInput);
  const exists = fs.existsSync(installStatePath);

  if (!exists) {
    return {
      adapter: {
        id: adapter.id,
        target: adapter.target,
        kind: adapter.kind,
      },
      targetRoot,
      installStatePath,
      exists: false,
      state: null,
      error: null,
    };
  }

  try {
    const state = readInstallState(installStatePath);
    return {
      adapter: {
        id: adapter.id,
        target: adapter.target,
        kind: adapter.kind,
      },
      targetRoot,
      installStatePath,
      exists: true,
      state,
      error: null,
    };
  } catch (error) {
    return {
      adapter: {
        id: adapter.id,
        target: adapter.target,
        kind: adapter.kind,
      },
      targetRoot,
      installStatePath,
      exists: true,
      state: null,
      error: error.message,
    };
  }
}

// Discovery enumerates ADAPTERS, not target ids: five targets ship
// home+project adapter pairs under one target id, and resolving those ids
// through getInstallTargetAdapter() always lands on the first (home)
// adapter -- which both duplicated the home record and left project
// installs of those targets invisible to doctor, repair, and uninstall.
function resolveDiscoveryAdapters(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return listInstallTargetAdapters();
  }

  const adapters = [];
  for (const target of normalizeTargets(targets)) {
    // normalizeTargets() already rejected unknown and retired ids with their
    // dedicated errors, so every canonical target here answers to at least
    // one adapter. Take every adapter that answers, not just the first: an
    // explicit --target kiro must cover kiro-home AND kiro-project, the
    // same pair the no-argument default examines.
    for (const adapter of listInstallTargetAdapters().filter(candidate => candidate.supports(target))) {
      if (!adapters.includes(adapter)) {
        adapters.push(adapter);
      }
    }
  }
  return adapters;
}

function discoverInstalledStates(options = {}) {
  const context = {
    homeDir: options.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir(),
    projectRoot: options.projectRoot || process.cwd(),
  };

  return resolveDiscoveryAdapters(options.targets).map(adapter => buildDiscoveryRecord(adapter, context));
}

function buildIssue(severity, code, message, extra = {}) {
  return {
    severity,
    code,
    message,
    ...extra,
  };
}

function determineStatus(issues) {
  if (issues.some(issue => issue.severity === 'error')) {
    return 'error';
  }

  if (issues.some(issue => issue.severity === 'warning')) {
    return 'warning';
  }

  return 'ok';
}

function checkTargetRootHealth(state, record) {
  const issues = [];

  if (!fs.existsSync(state.target.root)) {
    issues.push(buildIssue(
      'error',
      'missing-target-root',
      `Target root does not exist: ${state.target.root}`
    ));
  }

  if (state.target.root !== record.targetRoot) {
    issues.push(buildIssue(
      'warning',
      'target-root-mismatch',
      `Recorded target root differs from current target root (${record.targetRoot})`,
      {
        recordedTargetRoot: state.target.root,
        currentTargetRoot: record.targetRoot,
      }
    ));
  }

  if (state.target.installStatePath !== record.installStatePath) {
    issues.push(buildIssue(
      'warning',
      'install-state-path-mismatch',
      `Recorded install-state path differs from current path (${record.installStatePath})`,
      {
        recordedInstallStatePath: state.target.installStatePath,
        currentInstallStatePath: record.installStatePath,
      }
    ));
  }

  return issues;
}

function checkManagedOperationHealth(state, context) {
  const issues = [];
  const managedOperations = getManagedOperations(state);
  const operationHealth = summarizeManagedOperationHealth(context.repoRoot, managedOperations);

  if (operationHealth.missing.length > 0) {
    issues.push(buildIssue(
      'error',
      'missing-managed-files',
      `${operationHealth.missing.length} managed file(s) are missing`,
      {
        paths: operationHealth.missing.map(entry => entry.destinationPath),
      }
    ));
  }

  if (operationHealth.drifted.length > 0) {
    issues.push(buildIssue(
      'warning',
      'drifted-managed-files',
      `${operationHealth.drifted.length} managed file(s) differ from the source repo`,
      {
        paths: operationHealth.drifted.map(entry => entry.destinationPath),
      }
    ));
  }

  if (operationHealth.missingSource.length > 0) {
    issues.push(buildIssue(
      'error',
      'missing-source-files',
      `${operationHealth.missingSource.length} source file(s) referenced by install-state are missing (run 'egc repair' to prune orphaned entries)`,
      {
        paths: operationHealth.missingSource.map(entry => entry.sourcePath).filter(Boolean),
      }
    ));
  }

  if (operationHealth.unverified.length > 0) {
    issues.push(buildIssue(
      'warning',
      'unverified-managed-operations',
      `${operationHealth.unverified.length} managed operation(s) could not be content-verified`,
      {
        paths: operationHealth.unverified.map(entry => entry.destinationPath).filter(Boolean),
      }
    ));
  }

  return issues;
}

function checkVersionDrift(state, context) {
  const issues = [];

  if (state.source.manifestVersion !== context.manifestVersion) {
    issues.push(buildIssue(
      'warning',
      'manifest-version-mismatch',
      `Recorded manifest version ${state.source.manifestVersion} differs from current manifest version ${context.manifestVersion}`
    ));
  }

  if (
    context.packageVersion
    && state.source.repoVersion
    && state.source.repoVersion !== context.packageVersion
  ) {
    issues.push(buildIssue(
      'warning',
      'repo-version-mismatch',
      `Recorded repo version ${state.source.repoVersion} differs from current repo version ${context.packageVersion}`
    ));
  }

  return issues;
}

function checkResolutionDrift(record, state, context) {
  if (state.request.legacyMode) {
    return [];
  }

  try {
    const desiredPlan = resolveInstallPlan({
      repoRoot: context.repoRoot,
      projectRoot: context.projectRoot,
      homeDir: context.homeDir,
      target: record.adapter.target,
      profileId: state.request.profile || null,
      moduleIds: state.request.modules || [],
      includeComponentIds: state.request.includeComponents || [],
      excludeComponentIds: state.request.excludeComponents || [],
    });

    if (
      !compareStringArrays(desiredPlan.selectedModuleIds, state.resolution.selectedModules)
      || !compareStringArrays(desiredPlan.skippedModuleIds, state.resolution.skippedModules)
    ) {
      return [buildIssue(
        'warning',
        'resolution-drift',
        'Current manifest resolution differs from recorded install-state',
        {
          expectedSelectedModules: desiredPlan.selectedModuleIds,
          recordedSelectedModules: state.resolution.selectedModules,
          expectedSkippedModules: desiredPlan.skippedModuleIds,
          recordedSkippedModules: state.resolution.skippedModules,
        }
      )];
    }

    return [];
  } catch (error) {
    return [buildIssue('error', 'resolution-unavailable', error.message)];
  }
}

function analyzeRecord(record, context) {
  if (record.error) {
    const issues = [buildIssue('error', 'invalid-install-state', record.error)];
    return {
      ...record,
      status: determineStatus(issues),
      issues,
    };
  }

  const state = record.state;
  if (!state) {
    return {
      ...record,
      status: 'missing',
      issues: [],
    };
  }

  const issues = [
    ...checkTargetRootHealth(state, record),
    ...checkManagedOperationHealth(state, context),
    ...checkVersionDrift(state, context),
    ...checkResolutionDrift(record, state, context),
  ];

  return {
    ...record,
    status: determineStatus(issues),
    issues,
  };
}

function buildDoctorReport(options = {}) {
  const repoRoot = options.repoRoot || DEFAULT_REPO_ROOT;
  const manifests = loadInstallManifests({ repoRoot });
  const records = discoverInstalledStates({
    homeDir: options.homeDir,
    projectRoot: options.projectRoot,
    targets: options.targets,
  }).filter(record => record.exists);
  const context = {
    repoRoot,
    homeDir: options.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir(),
    projectRoot: options.projectRoot || process.cwd(),
    manifestVersion: manifests.modulesVersion,
    packageVersion: readPackageVersion(repoRoot),
  };
  const results = records.map(record => analyzeRecord(record, context));
  const summary = results.reduce((accumulator, result) => {
    const errorCount = result.issues.filter(issue => issue.severity === 'error').length;
    const warningCount = result.issues.filter(issue => issue.severity === 'warning').length;

    return {
      checkedCount: accumulator.checkedCount + 1,
      okCount: accumulator.okCount + (result.status === 'ok' ? 1 : 0),
      errorCount: accumulator.errorCount + errorCount,
      warningCount: accumulator.warningCount + warningCount,
    };
  }, {
    checkedCount: 0,
    okCount: 0,
    errorCount: 0,
    warningCount: 0,
  });

  return {
    generatedAt: new Date().toISOString(),
    packageVersion: context.packageVersion,
    manifestVersion: context.manifestVersion,
    results,
    summary,
  };
}

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
// so doctor converges to OK; the installed files stay on disk.
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

    syncInstallStateToStore(desiredPlan.statePreview, {
      onError: error => console.error(`Warning: Failed to sync install state to status store: ${error.message}`),
    });

    return {
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
    };
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
  const repoRoot = options.repoRoot || DEFAULT_REPO_ROOT;
  const manifests = loadInstallManifests({ repoRoot });
  const context = {
    repoRoot,
    homeDir: options.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir(),
    projectRoot: options.projectRoot || process.cwd(),
    manifestVersion: manifests.modulesVersion,
    packageVersion: readPackageVersion(repoRoot),
  };
  const records = discoverInstalledStates({
    homeDir: context.homeDir,
    projectRoot: context.projectRoot,
    targets: options.targets,
  }).filter(record => record.exists);

  const results = records.map(record => repairRecord(record, context, options));

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
    errorCount: 0,
    unrepairableCount: 0,
    prunedCount: 0,
    plannedPruneCount: 0,
  });

  return {
    dryRun: Boolean(options.dryRun),
    generatedAt: new Date().toISOString(),
    results,
    summary,
  };
}

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

function uninstallInstalledStates(options = {}) {
  const context = {
    repoRoot: options.repoRoot || DEFAULT_REPO_ROOT,
    homeDir: options.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir(),
    projectRoot: options.projectRoot || process.cwd(),
  };
  const records = discoverInstalledStates({
    homeDir: context.homeDir,
    projectRoot: context.projectRoot,
    targets: options.targets,
  }).filter(record => record.exists);

  const results = records.map(record => {
    if (record.error || !record.state) {
      return {
        adapter: record.adapter,
        status: 'error',
        installStatePath: record.installStatePath,
        removedPaths: [],
        plannedRemovals: [],
        error: record.error || 'No valid install-state available',
      };
    }

    const state = record.state;
    const operations = getManagedOperations(state);
    // Every recorded path is checked against the roots the adapter derives
    // today before anything is removed; one planted entry refuses the target.
    const escaping = findEscapingOperation(operations, record, context);
    if (escaping) {
      return {
        adapter: record.adapter,
        status: 'error',
        installStatePath: record.installStatePath,
        removedPaths: [],
        plannedRemovals: [],
        error: `Recorded operation escapes the managed roots for ${record.adapter.id}: ${escaping.destinationPath}`,
      };
    }
    const plannedRemovals = Array.from(new Set([
      ...operations.map(operation => operation.destinationPath),
      record.installStatePath,
    ]));

    if (options.dryRun) {
      return {
        adapter: record.adapter,
        status: 'planned',
        installStatePath: record.installStatePath,
        removedPaths: [],
        plannedRemovals,
        error: null,
      };
    }

    try {
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

      return {
        adapter: record.adapter,
        status: 'uninstalled',
        installStatePath: record.installStatePath,
        removedPaths,
        plannedRemovals: [],
        error: null,
      };
    } catch (error) {
      return {
        adapter: record.adapter,
        status: 'error',
        installStatePath: record.installStatePath,
        removedPaths: [],
        plannedRemovals,
        error: error.message,
      };
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
  DEFAULT_REPO_ROOT,
  buildDoctorReport,
  discoverInstalledStates,
  normalizeTargets,
  repairInstalledStates,
  uninstallInstalledStates,
};
