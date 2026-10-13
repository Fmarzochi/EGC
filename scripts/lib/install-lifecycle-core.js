'use strict';

// Shared primitives behind doctor, repair and uninstall: target normalization, recorded-operation containment, file comparison and JSON subset helpers.
// Part of the install-lifecycle.js split; that file re-exports the public surface.

const fs = require('node:fs');
const path = require('node:path');
const { hasParentSegment, isAnchoredPath, isInsideReal, realizePath } = require('./path-safety');
const { cloneJsonValue, isPlainObject, withoutPrototypeKeys } = require('./json-merge');
const { createManifestInstallPlan } = require('./install-executor');
const {
  getInstallTargetAdapter,
  listInstallTargetAdapters,
} = require('./install-targets/registry');
const { plannedFileContent } = require('./install/copy-transforms');

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

// Only the manifest-relative path recorded at install time is joined onto
// the reference repository; the absolute sourcePath stored next to it is
// never replayed, so a planted entry cannot make repair copy from anywhere,
// and a source that leaves the repository through a link is refused too.
function resolveOperationSourcePath(repoRoot, operation) {
  const relative = operation.sourceRelativePath;
  if (typeof relative !== 'string' || relative.trim() === '' || isAnchoredPath(relative) || hasParentSegment(relative)) {
    return null;
  }
  const joined = path.join(repoRoot, relative);
  return isInsideReal(joined, repoRoot) ? joined : null;
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
        files: new Set(operations.map(operation => realizePath(operation.destinationPath))),
        dirs: new Set(operations.filter(operation => operation.kind === 'copy-path').map(operation => realizePath(operation.destinationPath))),
      };
    } catch (_error) { // NOSONAR: a request the current manifest cannot plan falls through to the next attempt
      continue;
    }
  }
  return { files: new Set(), dirs: new Set() };
}

// A recorded operation may only touch the derived target root, a file the
// current manifest plans for this adapter, or a directory that plan copies.
// Every comparison is made on real locations (links followed, missing tails
// kept), so a link inside the root cannot point the replay outside it.
function operationEscapes(operation, root, planned) {
  const destination = operation.destinationPath;
  if (typeof destination !== 'string' || !isAnchoredPath(destination) || hasParentSegment(destination)) return true;
  const resolved = realizePath(destination);
  if (operation.kind === 'remove' && resolved === root) return true;
  if (isInsideReal(resolved, root)) return false;
  if (planned.files.has(resolved)) return false;
  return ![...planned.dirs].some(dir => isInsideReal(resolved, dir));
}

function findEscapingOperation(operations, record, context) {
  const root = realizePath(record.targetRoot);
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

    return areBuffersEqual(fs.readFileSync(leftPath), fs.readFileSync(rightPath));
  } catch (_error) { // NOSONAR: unreadable files are treated as different
    return false;
  }
}

// A byte mismatch that disappears once CRLF/LF are normalized is a
// line-ending artifact of the install pipeline (e.g. Windows core.autocrlf
// rewriting the repo's LF source on checkout, or a JSON rewrite step that
// always emits LF via JSON.stringify), not a real edit to the managed
// file: never flag it as drift.
function areBuffersEqual(left, right) {
  if (left.equals(right)) {
    return true;
  }
  return left.toString('utf8').replaceAll('\r\n', '\n') === right.toString('utf8').replaceAll('\r\n', '\n');
}

// The destination of a transformed copy is compared against the transformed
// source, with the same guards as areFilesEqual: a destination that became a
// directory or cannot be read is drift, not a crash of the doctor.
function areFilesEqualAfterTransform(sourcePath, destinationPath, transform) {
  try {
    if (!fs.statSync(destinationPath).isFile()) {
      return false;
    }
    return areBuffersEqual(plannedFileContent(sourcePath, transform), fs.readFileSync(destinationPath));
  } catch (_error) { // NOSONAR: unreadable files are treated as different
    return false;
  }
}

function readFileUtf8(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.codePointAt(0) === 0xFEFF ? content.slice(1) : content;
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
      // The recorded payload is read without prototype keys for every use
      // (merge, uninstall, inspection), so uninstall never removes a key EGC
      // never installed and inspection never reports one as drift.
      return withoutPrototypeKeys(parseJsonLikeValue(operation[key], `${operation.kind}.${key}`));
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

module.exports = {
  DEFAULT_REPO_ROOT,
  normalizeTargets,
  getManagedOperations,
  resolveOperationSourcePath,
  getOperationJsonPayload,
  getOperationPreviousContent,
  getOperationPreviousJson,
  formatJson,
  readJsonFile,
  ensureParentDir,
  JSON_REMOVE_SENTINEL,
  deepRemoveJsonSubset,
  areFilesEqual,
  areFilesEqualAfterTransform,
  readFileUtf8,
  jsonContainsSubset,
  readPackageVersion,
  compareStringArrays,
  assertRecordedOperationsContained,
  operationIdentityKey,
  findEscapingOperation,
};
