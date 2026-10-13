'use strict';

// Replay of recorded operations: the repair and uninstall executors for every managed operation kind.
// Part of the install-lifecycle.js split; that file re-exports the public surface.

const fs = require('node:fs');
const {
  copyFileKeepingMode,
  replaceFileWith,
  writeTextKeepingMode,
} = require('./install/preserving-write');
const { assertSafeMcpConfig, isMcpConfigPath, parseMcpConfigText } = require('./mcp-config');
const { deepMergeJson } = require('./json-merge');
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
  nextSkillIndexContent,
  removeIndexOperationContent,
} = require('./warp-agents-merge');
const {
  GENERATE_CONTEXT_FILE_KIND,
  nextGeneratedContextContent,
} = require('./generated-context-files');
const { plannedFileContent } = require('./install/copy-transforms');
const {
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
} = require('./install-lifecycle-core');

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
  if (isMcpConfigPath(operation.destinationPath)) {
    // A replayed MCP copy answers to the allowlist too, and the text that
    // was validated is the text that lands.
    const text = fs.readFileSync(sourcePath, 'utf8');
    assertSafeMcpConfig(parseMcpConfigText(text, sourcePath), sourcePath);
    writeTextKeepingMode(operation.destinationPath, text, sourcePath);
    return;
  }
  if (operation.transform) {
    writeTextKeepingMode(
      operation.destinationPath,
      plannedFileContent(sourcePath, operation.transform).toString('utf8'),
      sourcePath
    );
    return;
  }
  copyFileKeepingMode(sourcePath, operation.destinationPath);
}
function repairMergeJson(operation) {
  const payload = getOperationJsonPayload(operation);
  if (payload === undefined) {
    throw new Error(`Missing merge payload for repair: ${operation.destinationPath}`);
  }
  // A replayed payload is data from the state file, not a decision: it
  // answers to the same allowlist as a fresh install.
  if (isMcpConfigPath(operation.destinationPath)) {
    assertSafeMcpConfig(payload, `repair of ${operation.destinationPath}`);
  }

  const currentValue = fs.existsSync(operation.destinationPath)
    ? readJsonFile(operation.destinationPath)
    : {};
  const mergedValue = deepMergeJson(currentValue, payload);

  ensureParentDir(operation.destinationPath);
  replaceFileWith(operation.destinationPath, descriptor => fs.writeFileSync(descriptor, formatJson(mergedValue)));
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
  replaceFileWith(operation.destinationPath, descriptor => fs.writeFileSync(descriptor, nextContent));
}

function repairMergeMarkdownIndex(operation) {
  const existingContent = fs.existsSync(operation.destinationPath)
    ? fs.readFileSync(operation.destinationPath, 'utf8')
    : null;
  const nextContent = nextSkillIndexContent(existingContent, operation);
  if (nextContent === null || nextContent === existingContent) return;
  ensureParentDir(operation.destinationPath);
  replaceFileWith(operation.destinationPath, descriptor => fs.writeFileSync(descriptor, nextContent));
}

// Rewritten only when the file is gone or lost its project-memory section;
// a populated file is the healthy state, never a drift to undo.
function repairGeneratedContextFile(operation) {
  const existingContent = fs.existsSync(operation.destinationPath)
    ? fs.readFileSync(operation.destinationPath, 'utf8')
    : null;
  const nextContent = nextGeneratedContextContent(existingContent, operation);
  if (nextContent === null) return;
  ensureParentDir(operation.destinationPath);
  replaceFileWith(operation.destinationPath, descriptor => fs.writeFileSync(descriptor, nextContent));
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
  } else if (operation.kind === GENERATE_CONTEXT_FILE_KIND) {
    repairGeneratedContextFile(operation);
  } else {
    throw new Error(`Unsupported repair operation kind: ${operation.kind}`);
  }
}

function restorePreviousContent(operation) {
  const previousContent = getOperationPreviousContent(operation);
  if (previousContent !== null) {
    ensureParentDir(operation.destinationPath);
    replaceFileWith(operation.destinationPath, descriptor => fs.writeFileSync(descriptor, previousContent));
    return { removedPaths: [], cleanupTargets: [] };
  }

  const previousJson = getOperationPreviousJson(operation);
  if (previousJson !== undefined) {
    ensureParentDir(operation.destinationPath);
    replaceFileWith(operation.destinationPath, descriptor => fs.writeFileSync(descriptor, formatJson(previousJson)));
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
  replaceFileWith(operation.destinationPath, descriptor => fs.writeFileSync(descriptor, formatJson(nextValue)));
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
  replaceFileWith(operation.destinationPath, descriptor => fs.writeFileSync(descriptor, nextContent));
  return { removedPaths: [], cleanupTargets: [] };
}

function uninstallWarpAgentsIndexEntry(operation) {
  // Strips only what EGC added: the index entry from the marked block, or
  // the marked memory rule block. AGENTS.md itself is never deleted, even
  // if the block becomes empty -- it is an increasingly common cross-tool
  // convention file the user's other tools may also rely on.
  if ((!operation.skillName && !operation.memoryRule) || !fs.existsSync(operation.destinationPath)) {
    return { removedPaths: [], cleanupTargets: [] };
  }

  const existingContent = fs.readFileSync(operation.destinationPath, 'utf8');
  const nextContent = removeIndexOperationContent(existingContent, operation);
  ensureParentDir(operation.destinationPath);
  replaceFileWith(operation.destinationPath, descriptor => fs.writeFileSync(descriptor, nextContent));
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

// The generated file is a projection: the memory it may carry lives in the
// egc-memory state and comes back with the next propagation, so uninstall
// removes it like any managed copy.
function uninstallGeneratedContextFile(operation) {
  return uninstallCopyFile(operation);
}

const UNINSTALL_HANDLERS = {
  'copy-file': uninstallCopyFile,
  'merge-json': uninstallMergeJson,
  'remove': uninstallRemove,
  [HOOK_OPERATION_KIND]: uninstallManagedHookOperation,
  [MERGE_YAML_READ_LIST_KIND]: uninstallAiderConfigReadList,
  [MERGE_MARKDOWN_INDEX_KIND]: uninstallWarpAgentsIndexEntry,
  [GENERATE_CONTEXT_FILE_KIND]: uninstallGeneratedContextFile,
};

function executeUninstallOperation(operation) {
  const handler = UNINSTALL_HANDLERS[operation.kind];
  if (!handler) {
    throw new Error(`Unsupported uninstall operation kind: ${operation.kind}`);
  }
  return handler(operation);
}

module.exports = {
  hydrateRecordedOperations,
  buildRecordedStatePreview,
  shouldRepairFromRecordedOperations,
  executeRepairOperation,
  executeUninstallOperation,
};
