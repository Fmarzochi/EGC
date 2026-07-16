const fs = require('fs');
const os = require('os');
const path = require('path');

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
  PRE_TOOL_USE_EVENT,
  STOP_EVENT,
  USER_PROMPT_SUBMIT_EVENT,
  applyHookEntryToFile,
  applyIntuitionHookToFile,
  applySessionStartHookToFile,
  applyStopHookToFile,
  inspectHookEntryFile,
  inspectIntuitionHookFile,
  inspectSessionStartHookFile,
  inspectStopHookFile,
  removeHookEntryFromFile,
  removeIntuitionHookFromFile,
  removeSessionStartHookFromFile,
  removeStopHookFromFile,
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
  } catch (_error) {
    return null;
  }
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return listInstallTargetAdapters().map(adapter => adapter.target);
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
  return Array.isArray(state && state.operations)
    ? state.operations.filter(operation => operation.ownership === 'managed')
    : [];
}

function resolveOperationSourcePath(repoRoot, operation) {
  if (operation.sourceRelativePath) {
    return path.join(repoRoot, operation.sourceRelativePath);
  }

  return operation.sourcePath || null;
}

function areFilesEqual(leftPath, rightPath) {
  try {
    const leftStat = fs.statSync(leftPath);
    const rightStat = fs.statSync(rightPath);
    if (!leftStat.isFile() || !rightStat.isFile()) {
      return false;
    }

    return fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath));
  } catch (_error) {
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

  return JSON.parse(JSON.stringify(value));
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
      Object.prototype.hasOwnProperty.call(actualValue, key)
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

function deepRemoveJsonSubset(currentValue, managedValue) {
  if (isPlainObject(managedValue)) {
    if (!isPlainObject(currentValue)) {
      return currentValue;
    }

    const nextValue = { ...currentValue };
    for (const [key, value] of Object.entries(managedValue)) {
      if (!Object.prototype.hasOwnProperty.call(nextValue, key)) {
        continue;
      }

      if (isPlainObject(value)) {
        const nestedValue = deepRemoveJsonSubset(nextValue[key], value);
        if (nestedValue === JSON_REMOVE_SENTINEL) {
          delete nextValue[key];
        } else {
          nextValue[key] = nestedValue;
        }
        continue;
      }

      if (Array.isArray(value)) {
        if (Array.isArray(nextValue[key]) && jsonContainsSubset(nextValue[key], value)) {
          delete nextValue[key];
        }
        continue;
      }

      if (nextValue[key] === value) {
        delete nextValue[key];
      }
    }

    return Object.keys(nextValue).length === 0 ? JSON_REMOVE_SENTINEL : nextValue;
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

function repairClaudeSettingsHook(operation) {
  if (operation.hookEvent === STOP_EVENT) {
    applyStopHookToFile(operation.destinationPath, operation.hookScriptPath);
  } else if (operation.hookEvent === USER_PROMPT_SUBMIT_EVENT) {
    applyIntuitionHookToFile(operation.destinationPath, operation.hookScriptPath);
  } else if (operation.hookEvent === PRE_TOOL_USE_EVENT) {
    applyHookEntryToFile(operation.destinationPath, PRE_TOOL_USE_EVENT, operation.hookScriptPath, { matcher: operation.hookMatcher });
  } else {
    applySessionStartHookToFile(operation.destinationPath, operation.hookScriptPath);
  }
}

function executeRepairOperation(repoRoot, operation) {
  if (operation.kind === 'copy-file') {
    const sourcePath = resolveOperationSourcePath(repoRoot, operation);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error(`Missing source file for repair: ${sourcePath || operation.sourceRelativePath}`);
    }

    ensureParentDir(operation.destinationPath);
    fs.copyFileSync(sourcePath, operation.destinationPath);
    return;
  }

  if (operation.kind === 'merge-json') {
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
    return;
  }

  if (operation.kind === 'remove') {
    if (!fs.existsSync(operation.destinationPath)) {
      return;
    }

    fs.rmSync(operation.destinationPath, { recursive: true, force: true });
    return;
  }

  if (operation.kind === HOOK_OPERATION_KIND) {
    repairClaudeSettingsHook(operation);
    return;
  }

  if (operation.kind === MERGE_YAML_READ_LIST_KIND) {
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
    return;
  }

  if (operation.kind === MERGE_MARKDOWN_INDEX_KIND) {
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
    return;
  }

  throw new Error(`Unsupported repair operation kind: ${operation.kind}`);
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

function uninstallClaudeSettingsHook(operation) {
  // Strips only the EGC-managed hook entry. The settings file itself is never
  // deleted because Claude Code and the user own its other keys.
  if (operation.hookEvent === STOP_EVENT) {
    removeStopHookFromFile(operation.destinationPath, operation.hookScriptPath);
  } else if (operation.hookEvent === USER_PROMPT_SUBMIT_EVENT) {
    removeIntuitionHookFromFile(operation.destinationPath, operation.hookScriptPath);
  } else if (operation.hookEvent === PRE_TOOL_USE_EVENT) {
    removeHookEntryFromFile(operation.destinationPath, PRE_TOOL_USE_EVENT, operation.hookScriptPath);
  } else {
    removeSessionStartHookFromFile(operation.destinationPath, operation.hookScriptPath);
  }
  return { removedPaths: [], cleanupTargets: [] };
}

const UNINSTALL_HANDLERS = {
  'copy-file': uninstallCopyFile,
  'merge-json': uninstallMergeJson,
  'remove': uninstallRemove,
  [HOOK_OPERATION_KIND]: uninstallClaudeSettingsHook,
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
  } catch (_error) {
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
  } catch (_error) {
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
    if (operation.hookEvent === STOP_EVENT) {
      return inspectResult(inspectStopHookFile(destinationPath, operation.hookScriptPath), operation, destinationPath);
    }
    if (operation.hookEvent === USER_PROMPT_SUBMIT_EVENT) {
      return inspectResult(inspectIntuitionHookFile(destinationPath, operation.hookScriptPath), operation, destinationPath);
    }
    if (operation.hookEvent === PRE_TOOL_USE_EVENT) {
      return inspectResult(inspectHookEntryFile(destinationPath, PRE_TOOL_USE_EVENT, operation.hookScriptPath, operation.hookMatcher), operation, destinationPath);
    }
    return inspectResult(inspectSessionStartHookFile(destinationPath, operation.hookScriptPath), operation, destinationPath);
  }

  if (operation.kind === MERGE_YAML_READ_LIST_KIND) {
    return inspectAiderConfigReadListOperation(operation, destinationPath);
  }

  if (operation.kind === MERGE_MARKDOWN_INDEX_KIND) {
    return inspectWarpAgentsIndexOperation(operation, destinationPath);
  }

  return inspectResult('unverified', operation, destinationPath);
}

function summarizeManagedOperationHealth(repoRoot, operations) {
  return operations.reduce((summary, operation) => {
    const inspection = inspectManagedOperation(repoRoot, operation);
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

function discoverInstalledStates(options = {}) {
  const context = {
    homeDir: options.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir(),
    projectRoot: options.projectRoot || process.cwd(),
  };
  const targets = normalizeTargets(options.targets);

  return targets.map(target => {
    const adapter = getInstallTargetAdapter(target);
    return buildDiscoveryRecord(adapter, context);
  });
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
      `${operationHealth.missingSource.length} source file(s) referenced by install-state are missing`,
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
    const statePreview = buildRecordedStatePreview(state, context, operations);

    return {
      mode: state.request.legacyMode ? 'legacy' : 'recorded',
      target: record.adapter.target,
      adapter: record.adapter,
      targetRoot: state.target.root,
      installRoot: state.target.root,
      installStatePath: state.target.installStatePath,
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

  const results = records.map(record => {
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

      if (operationHealth.missingSource.length > 0) {
        return {
          adapter: record.adapter,
          status: 'error',
          installStatePath: record.installStatePath,
          repairedPaths: [],
          plannedRepairs: [],
          error: `Missing source file(s): ${operationHealth.missingSource.map(entry => entry.sourcePath).join(', ')}`,
        };
      }

      const repairOperations = [
        ...operationHealth.missing.map(entry => ({ ...entry.operation })),
        ...operationHealth.drifted.map(entry => ({ ...entry.operation })),
      ];
      const plannedRepairs = repairOperations.map(operation => operation.destinationPath);

      if (options.dryRun) {
        return {
          adapter: record.adapter,
          status: plannedRepairs.length > 0 ? 'planned' : 'ok',
          installStatePath: record.installStatePath,
          repairedPaths: [],
          plannedRepairs,
          stateRefreshed: plannedRepairs.length === 0,
          error: null,
        };
      }

      if (repairOperations.length > 0) {
        for (const operation of repairOperations) {
          executeRepairOperation(context.repoRoot, operation);
        }
        writeInstallState(desiredPlan.installStatePath, desiredPlan.statePreview);
      } else {
        writeInstallState(desiredPlan.installStatePath, desiredPlan.statePreview);
      }

      syncInstallStateToStore(desiredPlan.statePreview, {
        onError: error => console.error(`Warning: Failed to sync install state to status store: ${error.message}`),
      });

      return {
        adapter: record.adapter,
        status: repairOperations.length > 0 ? 'repaired' : 'ok',
        installStatePath: record.installStatePath,
        repairedPaths: plannedRepairs,
        plannedRepairs: [],
        stateRefreshed: true,
        error: null,
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
  });

  const summary = results.reduce((accumulator, result) => ({
    checkedCount: accumulator.checkedCount + 1,
    repairedCount: accumulator.repairedCount + (result.status === 'repaired' ? 1 : 0),
    plannedRepairCount: accumulator.plannedRepairCount + (result.status === 'planned' ? 1 : 0),
    errorCount: accumulator.errorCount + (result.status === 'error' ? 1 : 0),
  }), {
    checkedCount: 0,
    repairedCount: 0,
    plannedRepairCount: 0,
    errorCount: 0,
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
  const records = discoverInstalledStates({
    homeDir: options.homeDir,
    projectRoot: options.projectRoot,
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
    const plannedRemovals = Array.from(new Set([
      ...getManagedOperations(state).map(operation => operation.destinationPath),
      state.target.installStatePath,
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
      const operations = getManagedOperations(state);

      for (const operation of operations) {
        const outcome = executeUninstallOperation(operation);
        removedPaths.push(...outcome.removedPaths);
        cleanupTargets.push(...outcome.cleanupTargets);
      }

      if (fs.existsSync(state.target.installStatePath)) {
        fs.rmSync(state.target.installStatePath, { force: true });
        removedPaths.push(state.target.installStatePath);
        cleanupTargets.push(state.target.installStatePath);
      }

      for (const cleanupTarget of cleanupTargets) {
        cleanupEmptyParentDirs(cleanupTarget, state.target.root);
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
