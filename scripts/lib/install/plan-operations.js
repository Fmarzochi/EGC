const fs = require('node:fs');
const path = require('node:path');

const { isGeneratedRuntimeSourcePath, isHostPlacedSourcePath, isIgnoredSourceDirectory, isIgnoredSourceFile } = require('../install-source-filters');
const { HOOK_OPERATION_KIND } = require('../claude-settings-hooks');
const { MERGE_YAML_READ_LIST_KIND } = require('../aider-config-merge');
const { MERGE_MARKDOWN_INDEX_KIND } = require('../warp-agents-merge');
const { GENERATE_CONTEXT_FILE_KIND, createGeneratedContextOperation, isGeneratedContextSource } = require('../generated-context-files');
const { assertSafeMcpConfig, isMcpConfigPath } = require('../mcp-config');

// Builders for the install plan's operations, and the pass that turns the
// manifest's scaffold operations into concrete ones.

function listFilesRecursive(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const files = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredSourceDirectory(entry.name)) {
        continue;
      }
      const childFiles = listFilesRecursive(absolutePath);
      for (const childFile of childFiles) {
        files.push(path.join(entry.name, childFile));
      }
    } else if (entry.isFile() && !isIgnoredSourceFile(entry.name)) {
      files.push(entry.name);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

// The repository's .agents/skills directory is the Codex-facing copy of the
// catalog: a SKILL.md per skill in the shape Codex accepts, plus files the
// catalog does not carry (the openai.yaml metadata, the egc skill). Codex,
// Goose and OpenHands share the ~/.agents root, and Goose and OpenHands
// receive the catalog skills there, so at a destination both deliver the
// catalog copy wins whatever the manifest order: one source per file, and
// the last install no longer overwrites what the others recorded. What only
// the mirror has still ships.
const CATALOG_MIRROR_SOURCE_DIRS = Object.freeze(['.agents/skills']);

function isCatalogMirrorSourcePath(sourceRelativePath) {
  const normalizedPath = String(sourceRelativePath || '').replaceAll('\\', '/');
  return CATALOG_MIRROR_SOURCE_DIRS.some(dir => normalizedPath === dir || normalizedPath.startsWith(`${dir}/`));
}

function buildCopyFileOperation({ moduleId, sourcePath, sourceRelativePath, destinationPath, strategy, transform }) {
  return {
    kind: 'copy-file',
    moduleId,
    sourcePath,
    sourceRelativePath,
    destinationPath,
    strategy,
    ownership: 'managed',
    scaffoldOnly: false,
    ...(transform ? { transform } : {}),
  };
}

function addRecursiveCopyOperations(operations, options) {
  const sourceDir = path.join(options.sourceRoot, options.sourceRelativeDir);
  if (!fs.existsSync(sourceDir)) {
    return 0;
  }

  const relativeFiles = listFilesRecursive(sourceDir);

  for (const relativeFile of relativeFiles) {
    const sourceRelativePath = path.join(options.sourceRelativeDir, relativeFile);
    const sourcePath = path.join(options.sourceRoot, sourceRelativePath);
    const destinationRelativePath = typeof options.destinationRelativePathTransform === 'function'
      ? options.destinationRelativePathTransform(relativeFile, sourceRelativePath)
      : relativeFile;
    if (!destinationRelativePath) {
      continue;
    }
    const destinationPath = path.join(options.destinationDir, destinationRelativePath);
    operations.push(buildCopyFileOperation({
      moduleId: options.moduleId,
      sourcePath,
      sourceRelativePath,
      destinationPath,
      strategy: options.strategy || 'preserve-relative-path',
    }));
  }

  return relativeFiles.length;
}

function addFileCopyOperation(operations, options) {
  const sourcePath = path.join(options.sourceRoot, options.sourceRelativePath);
  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  operations.push(buildCopyFileOperation({
    moduleId: options.moduleId,
    sourcePath,
    sourceRelativePath: options.sourceRelativePath,
    destinationPath: options.destinationPath,
    strategy: options.strategy || 'preserve-relative-path',
  }));

  return true;
}

function readJsonObject(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse ${label} at ${filePath}: ${error.message}`, { cause: error });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label} at ${filePath}: expected a JSON object`);
  }

  return parsed;
}

// An MCP config payload answers to the command allowlist the moment it is
// read, so a bad entry fails the plan instead of reaching a live config.
function readMergePayload(sourceRoot, sourceRelativePath, destinationPath) {
  const payload = readJsonObject(path.join(sourceRoot, sourceRelativePath), sourceRelativePath);
  if (isMcpConfigPath(destinationPath)) {
    assertSafeMcpConfig(payload, sourceRelativePath);
  }
  return payload;
}

function addJsonMergeOperation(operations, options) {
  const sourcePath = path.join(options.sourceRoot, options.sourceRelativePath);
  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  operations.push({
    kind: 'merge-json',
    moduleId: options.moduleId,
    sourceRelativePath: options.sourceRelativePath,
    destinationPath: options.destinationPath,
    strategy: 'merge-json',
    ownership: 'managed',
    scaffoldOnly: false,
    mergePayload: readMergePayload(options.sourceRoot, options.sourceRelativePath, options.destinationPath),
  });

  return true;
}

function addMatchingRuleOperations(operations, options) {
  const sourceDir = path.join(options.sourceRoot, options.sourceRelativeDir);
  if (!fs.existsSync(sourceDir)) {
    return 0;
  }

  const files = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && options.matcher(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const fileName of files) {
    const sourceRelativePath = path.join(options.sourceRelativeDir, fileName);
    const sourcePath = path.join(options.sourceRoot, sourceRelativePath);
    const destinationPath = path.join(
      options.destinationDir,
      options.rename ? options.rename(fileName) : fileName
    );

    operations.push(buildCopyFileOperation({
      moduleId: options.moduleId,
      sourcePath,
      sourceRelativePath,
      destinationPath,
      strategy: options.strategy || 'flatten-copy',
    }));
  }

  return files.length;
}

function isDirectoryNonEmpty(dirPath) {
  return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory() && fs.readdirSync(dirPath).length > 0;
}

function materializeScaffoldOperation(sourceRoot, operation) {
  if (operation.kind === HOOK_OPERATION_KIND) {
    return [{ ...operation, scaffoldOnly: false }];
  }

  if (operation.kind === MERGE_YAML_READ_LIST_KIND) {
    return [{ ...operation, scaffoldOnly: false }];
  }

  if (operation.kind === MERGE_MARKDOWN_INDEX_KIND || operation.kind === GENERATE_CONTEXT_FILE_KIND) {
    return [{ ...operation, scaffoldOnly: false }];
  }

  // A scaffold that names a propagation-filled context file (the root
  // AGENTS.md an adapter lays out) becomes the generated form whether or
  // not the source is on disk: a registry install has no such file, a clone
  // has it populated, and both must plan the same destination.
  if (isGeneratedContextSource(operation.sourceRelativePath)) {
    return [createGeneratedContextOperation({
      moduleId: operation.moduleId,
      sourceRelativePath: operation.sourceRelativePath,
      destinationPath: operation.destinationPath,
    })];
  }

  if (operation.kind === 'merge-json') {
    return [{
      kind: 'merge-json',
      moduleId: operation.moduleId,
      sourceRelativePath: operation.sourceRelativePath,
      destinationPath: operation.destinationPath,
      strategy: operation.strategy || 'merge-json',
      ownership: operation.ownership || 'managed',
      scaffoldOnly: Object.hasOwn(operation, 'scaffoldOnly') ? operation.scaffoldOnly : false,
      mergePayload: readMergePayload(sourceRoot, operation.sourceRelativePath, operation.destinationPath),
    }];
  }

  const sourcePath = path.join(sourceRoot, operation.sourceRelativePath);
  if (!fs.existsSync(sourcePath)) {
    return [];
  }

  if (isGeneratedRuntimeSourcePath(operation.sourceRelativePath)) {
    return [];
  }

  const stat = fs.statSync(sourcePath);
  if (stat.isFile()) {
    return [buildCopyFileOperation({
      moduleId: operation.moduleId,
      sourcePath,
      sourceRelativePath: operation.sourceRelativePath,
      destinationPath: operation.destinationPath,
      strategy: operation.strategy,
      transform: operation.transform,
    })];
  }

  const relativeFiles = listFilesRecursive(sourcePath).filter(relativeFile => {
    const sourceRelativePath = path.join(operation.sourceRelativePath, relativeFile);
    return !isGeneratedRuntimeSourcePath(sourceRelativePath) && !isHostPlacedSourcePath(sourceRelativePath);
  });
  return relativeFiles.map(relativeFile => {
    const sourceRelativePath = path.join(operation.sourceRelativePath, relativeFile);
    return buildCopyFileOperation({
      moduleId: operation.moduleId,
      sourcePath: path.join(sourcePath, relativeFile),
      sourceRelativePath,
      destinationPath: path.join(operation.destinationPath, relativeFile),
      strategy: operation.strategy,
      transform: operation.transform,
    });
  });
}

// Two modules can record a copy-file for the same destination with different
// sources: on the codex target the native .agents tree (agents-core) and the
// flattened skills/<category> catalog modules both cover
// <root>/skills/<name>/SKILL.md, and the two sources differ in frontmatter.
// apply.js writes operations in order, so the last writer wins on disk while
// every other recorded owner keeps flagging the file as drifted in doctor,
// and repair re-copies it back and forth between sources forever. One
// destination keeps exactly one copy-file operation: the one whose source
// lives under the adapter's native tree when the target has one (the native
// layout is that target's own propagated format), otherwise the first
// recorded one.
function dedupeCopyFileDestinations(operations, nativeRootRelativePath) {
  let nativeRoot = String(nativeRootRelativePath || '').replaceAll('\\', '/');
  while (nativeRoot.endsWith('/')) {
    nativeRoot = nativeRoot.slice(0, -1);
  }
  const isNativeSource = operation => {
    if (!nativeRoot) {
      return false;
    }
    const source = String(operation.sourceRelativePath || '').replaceAll('\\', '/');
    return source === nativeRoot || source.startsWith(`${nativeRoot}/`);
  };

  const winnerIndexByDestination = new Map();
  const result = [];
  // A generated catalog never shadows a file another module copies to the
  // same place: on the codex target the native .agents/AGENTS.md lands at
  // ~/.agents/AGENTS.md, where the root AGENTS.md would also be generated,
  // and the copied file is what a registry install always had there.
  const copiedDestinations = new Set(operations
    .filter(operation => operation.kind === 'copy-file')
    .map(operation => operation.destinationPath));

  for (const operation of operations) {
    if (operation.kind === GENERATE_CONTEXT_FILE_KIND && copiedDestinations.has(operation.destinationPath)) {
      continue;
    }
    if (operation.kind !== 'copy-file') {
      result.push(operation);
      continue;
    }

    const winnerIndex = winnerIndexByDestination.get(operation.destinationPath);
    if (winnerIndex === undefined) {
      winnerIndexByDestination.set(operation.destinationPath, result.length);
      result.push(operation);
      continue;
    }

    // A mirror copy never displaces another owner, and any other source
    // displaces a mirror copy; between two other sources the native tree
    // keeps its preference.
    const winner = result[winnerIndex];
    if (isCatalogMirrorSourcePath(operation.sourceRelativePath)) {
      continue;
    }
    if (isCatalogMirrorSourcePath(winner.sourceRelativePath) || (isNativeSource(operation) && !isNativeSource(winner))) {
      result[winnerIndex] = operation;
    }
  }

  return result;
}

module.exports = {
  addFileCopyOperation,
  addJsonMergeOperation,
  addMatchingRuleOperations,
  addRecursiveCopyOperations,
  buildCopyFileOperation,
  dedupeCopyFileDestinations,
  isDirectoryNonEmpty,
  listFilesRecursive,
  materializeScaffoldOperation,
};
