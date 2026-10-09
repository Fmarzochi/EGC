const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { toCursorAgentRelativePath } = require('./cursor-agent-names');
const { LEGACY_INSTALL_TARGETS, parseInstallArgs } = require('./install/request');
const {
  SUPPORTED_INSTALL_TARGETS,
  listLegacyCompatibilityLanguages,
  resolveLegacyCompatibilitySelection,
  resolveInstallPlan,
} = require('./install-manifests');
const { getInstallTargetAdapter } = require('./install-targets/registry');
const { AGY_RULES_SUBDIR, isPersonCopy, planAntigravityRuleFiles, readRecordedDestinations } = require('./antigravity-rules');
const { planAntigravityAgentFiles } = require('./antigravity-agents');
const { isGeneratedRuntimeSourcePath, isHostPlacedSourcePath, isIgnoredSourceDirectory, isIgnoredSourceFile } = require('./install-source-filters');
const { HOOK_OPERATION_KIND } = require('./claude-settings-hooks');
const { MERGE_YAML_READ_LIST_KIND } = require('./aider-config-merge');
const { MERGE_MARKDOWN_INDEX_KIND } = require('./warp-agents-merge');
const { assertSafeMcpConfig, isMcpConfigPath } = require('./mcp-config');

const LANGUAGE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function getSourceRoot() {
  return path.join(__dirname, '../..');
}

function getPackageVersion(sourceRoot) {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')
    );
    return packageJson.version || null;
  } catch (_error) { // NOSONAR: unreadable package.json means unknown version
    return null;
  }
}

function getManifestVersion(sourceRoot) {
  try {
    const modulesManifest = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'manifests', 'install-modules.json'), 'utf8')
    );
    return modulesManifest.version || 1;
  } catch (_error) { // NOSONAR: missing manifest defaults to version 1
    return 1;
  }
}

function getRepoCommit(sourceRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: sourceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch (_error) { // NOSONAR: git being unavailable yields null commit info
    return null;
  }
}

function readDirectoryNames(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function listAvailableLanguages(sourceRoot = getSourceRoot()) {
  return [...new Set([
    ...listLegacyCompatibilityLanguages(),
    ...readDirectoryNames(path.join(sourceRoot, 'rules'))
      .filter(name => name !== 'common'),
  ])].sort((a, b) => a.localeCompare(b));
}

function validateLegacyTarget(target) {
  if (!LEGACY_INSTALL_TARGETS.includes(target)) {
    throw new Error(
      `Unknown install target: ${target}. Expected one of ${LEGACY_INSTALL_TARGETS.join(', ')}`
    );
  }
}

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

function createStatePreview(options) {
  const { createInstallState } = require('./install-state');
  return createInstallState(options);
}

function applyInstallPlan(plan) {
  const { applyInstallPlan: applyPlan } = require('./install/apply');
  return applyPlan(plan);
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

function planEGCLegacyInstall(context) {
  const adapter = getInstallTargetAdapter('egc');
  const targetRoot = adapter.resolveRoot({ homeDir: context.homeDir });
  const rulesDir = context.geminiRulesDir || path.join(targetRoot, AGY_RULES_SUBDIR);
  const installStatePath = adapter.getInstallStatePath({ homeDir: context.homeDir });
  const operations = [];
  const warnings = [];

  if (isDirectoryNonEmpty(rulesDir)) {
    warnings.push(
      `Destination ${rulesDir}/ already exists and files may be overwritten`
    );
  }

  const recordedDestinations = readRecordedDestinations(installStatePath);
  const addRules = sourceRelativeDir => {
    for (const rule of planAntigravityRuleFiles(context.sourceRoot, sourceRelativeDir)) {
      const sourcePath = path.join(context.sourceRoot, rule.sourceRelativePath);
      const destinationPath = path.join(rulesDir, rule.fileName);
      if (isPersonCopy(destinationPath, sourcePath, rule.transform, recordedDestinations)) {
        continue;
      }
      operations.push(buildCopyFileOperation({
        moduleId: 'legacy-egc-rules',
        sourcePath,
        sourceRelativePath: rule.sourceRelativePath,
        destinationPath,
        strategy: 'flatten-copy',
        transform: rule.transform,
      }));
    }
  };

  addRules('rules/common');

  for (const language of context.languages) {
    if (!LANGUAGE_NAME_PATTERN.test(language)) {
      warnings.push(
        `Invalid language name '${language}'. Only alphanumeric, dash, and underscore are allowed`
      );
      continue;
    }

    const sourceDir = path.join(context.sourceRoot, 'rules', language);
    if (!fs.existsSync(sourceDir)) {
      warnings.push(`rules/${language}/ does not exist, skipping`);
      continue;
    }

    addRules(`rules/${language}`);
  }

  return {
    mode: 'legacy',
    adapter,
    target: 'egc',
    targetRoot,
    installRoot: rulesDir,
    installStatePath,
    operations,
    warnings,
    selectedModules: ['legacy-egc-rules'],
  };
}

function planCursorLegacyInstall(context) {
  const adapter = getInstallTargetAdapter('cursor');
  const targetRoot = adapter.resolveRoot({ repoRoot: context.projectRoot });
  const installStatePath = adapter.getInstallStatePath({ repoRoot: context.projectRoot });
  const operations = [];
  const warnings = [];

  addMatchingRuleOperations(operations, {
    moduleId: 'legacy-cursor-install',
    sourceRoot: context.sourceRoot,
    sourceRelativeDir: path.join('.cursor', 'rules'),
    destinationDir: path.join(targetRoot, 'rules'),
    matcher: fileName => /^common-.*\.md$/.test(fileName),
  });

  for (const language of context.languages) {
    if (!LANGUAGE_NAME_PATTERN.test(language)) {
      warnings.push(
        `Invalid language name '${language}'. Only alphanumeric, dash, and underscore are allowed`
      );
      continue;
    }

    const matches = addMatchingRuleOperations(operations, {
      moduleId: 'legacy-cursor-install',
      sourceRoot: context.sourceRoot,
      sourceRelativeDir: path.join('.cursor', 'rules'),
      destinationDir: path.join(targetRoot, 'rules'),
      matcher: fileName => fileName.startsWith(`${language}-`) && fileName.endsWith('.md'),
    });

    if (matches === 0) {
      warnings.push(`No Cursor rules for '${language}' found, skipping`);
    }
  }

  addRecursiveCopyOperations(operations, {
    moduleId: 'legacy-cursor-install',
    sourceRoot: context.sourceRoot,
    sourceRelativeDir: path.join('.cursor', 'agents'),
    destinationDir: path.join(targetRoot, 'agents'),
    destinationRelativePathTransform: toCursorAgentRelativePath,
  });
  addRecursiveCopyOperations(operations, {
    moduleId: 'legacy-cursor-install',
    sourceRoot: context.sourceRoot,
    sourceRelativeDir: path.join('.cursor', 'skills'),
    destinationDir: path.join(targetRoot, 'skills'),
  });
  addRecursiveCopyOperations(operations, {
    moduleId: 'legacy-cursor-install',
    sourceRoot: context.sourceRoot,
    sourceRelativeDir: path.join('.cursor', 'commands'),
    destinationDir: path.join(targetRoot, 'commands'),
  });
  addRecursiveCopyOperations(operations, {
    moduleId: 'legacy-cursor-install',
    sourceRoot: context.sourceRoot,
    sourceRelativeDir: path.join('.cursor', 'hooks'),
    destinationDir: path.join(targetRoot, 'hooks'),
  });

  addFileCopyOperation(operations, {
    moduleId: 'legacy-cursor-install',
    sourceRoot: context.sourceRoot,
    sourceRelativePath: path.join('.cursor', 'hooks.json'),
    destinationPath: path.join(targetRoot, 'hooks.json'),
  });
  addJsonMergeOperation(operations, {
    moduleId: 'legacy-cursor-install',
    sourceRoot: context.sourceRoot,
    sourceRelativePath: '.mcp.json',
    destinationPath: path.join(targetRoot, 'mcp.json'),
  });

  return {
    mode: 'legacy',
    adapter,
    target: 'cursor',
    targetRoot,
    installRoot: targetRoot,
    installStatePath,
    operations,
    warnings,
    selectedModules: ['legacy-cursor-install'],
  };
}

function planAntigravityLegacyInstall(context) {
  const adapter = getInstallTargetAdapter('antigravity');
  const targetRoot = adapter.resolveRoot({ repoRoot: context.projectRoot });
  const installStatePath = adapter.getInstallStatePath({ repoRoot: context.projectRoot });
  const operations = [];
  const warnings = [];

  if (isDirectoryNonEmpty(path.join(targetRoot, 'rules'))) {
    warnings.push(
      `Destination ${path.join(targetRoot, 'rules')}/ already exists and files may be overwritten`
    );
  }

  addMatchingRuleOperations(operations, {
    moduleId: 'legacy-antigravity-install',
    sourceRoot: context.sourceRoot,
    sourceRelativeDir: path.join('rules', 'common'),
    destinationDir: path.join(targetRoot, 'rules'),
    matcher: fileName => fileName.endsWith('.md'),
    rename: fileName => `common-${fileName}`,
  });

  for (const language of context.languages) {
    if (!LANGUAGE_NAME_PATTERN.test(language)) {
      warnings.push(
        `Invalid language name '${language}'. Only alphanumeric, dash, and underscore are allowed`
      );
      continue;
    }

    const sourceDir = path.join(context.sourceRoot, 'rules', language);
    if (!fs.existsSync(sourceDir)) {
      warnings.push(`rules/${language}/ does not exist, skipping`);
      continue;
    }

    addMatchingRuleOperations(operations, {
      moduleId: 'legacy-antigravity-install',
      sourceRoot: context.sourceRoot,
      sourceRelativeDir: path.join('rules', language),
      destinationDir: path.join(targetRoot, 'rules'),
      matcher: fileName => fileName.endsWith('.md'),
      rename: fileName => `${language}-${fileName}`,
    });
  }

  addRecursiveCopyOperations(operations, {
    moduleId: 'legacy-antigravity-install',
    sourceRoot: context.sourceRoot,
    sourceRelativeDir: 'commands',
    destinationDir: path.join(targetRoot, 'workflows'),
  });
  const recordedDestinations = readRecordedDestinations(installStatePath);
  for (const agent of planAntigravityAgentFiles(context.sourceRoot, 'agents')) {
    const sourcePath = path.join(context.sourceRoot, agent.sourceRelativePath);
    const destinationPath = path.join(targetRoot, 'agents', agent.fileName);
    if (isPersonCopy(destinationPath, sourcePath, agent.transform, recordedDestinations)) {
      continue;
    }
    operations.push(buildCopyFileOperation({
      moduleId: 'legacy-antigravity-install',
      sourcePath,
      sourceRelativePath: agent.sourceRelativePath,
      destinationPath,
      strategy: 'flatten-copy',
      transform: agent.transform,
    }));
  }
  addRecursiveCopyOperations(operations, {
    moduleId: 'legacy-antigravity-install',
    sourceRoot: context.sourceRoot,
    sourceRelativeDir: 'skills',
    destinationDir: path.join(targetRoot, 'skills'),
  });

  return {
    mode: 'legacy',
    adapter,
    target: 'antigravity',
    targetRoot,
    installRoot: targetRoot,
    installStatePath,
    operations,
    warnings,
    selectedModules: ['legacy-antigravity-install'],
  };
}

function createLegacyInstallPlan(options = {}) {
  const sourceRoot = options.sourceRoot || getSourceRoot();
  const projectRoot = options.projectRoot || process.cwd();
  const homeDir = options.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const target = options.target || 'egc';

  validateLegacyTarget(target);

  const context = {
    sourceRoot,
    projectRoot,
    homeDir,
    languages: Array.isArray(options.languages) ? options.languages : [],
    geminiRulesDir: options.geminiRulesDir || options.claudeRulesDir || process.env.GEMINI_RULES_DIR || null,
  };

  let plan;
  if (target === 'egc') {
    plan = planEGCLegacyInstall(context);
  } else if (target === 'cursor') {
    plan = planCursorLegacyInstall(context);
  } else {
    plan = planAntigravityLegacyInstall(context);
  }

  const source = {
    repoVersion: getPackageVersion(sourceRoot),
    repoCommit: getRepoCommit(sourceRoot),
    manifestVersion: getManifestVersion(sourceRoot),
  };

  const statePreview = createStatePreview({
    adapter: plan.adapter,
    targetRoot: plan.targetRoot,
    installStatePath: plan.installStatePath,
    request: {
      profile: null,
      modules: [],
      legacyLanguages: context.languages,
      legacyMode: true,
    },
    resolution: {
      selectedModules: plan.selectedModules,
      skippedModules: [],
    },
    operations: plan.operations,
    source,
  });

  return {
    mode: 'legacy',
    target: plan.target,
    adapter: {
      id: plan.adapter.id,
      target: plan.adapter.target,
      kind: plan.adapter.kind,
    },
    targetRoot: plan.targetRoot,
    installRoot: plan.installRoot,
    installStatePath: plan.installStatePath,
    warnings: plan.warnings,
    languages: context.languages,
    operations: plan.operations,
    statePreview,
  };
}

function createLegacyCompatInstallPlan(options = {}) {
  const sourceRoot = options.sourceRoot || getSourceRoot();
  const projectRoot = options.projectRoot || process.cwd();
  const target = options.target || 'egc';

  validateLegacyTarget(target);

  const selection = resolveLegacyCompatibilitySelection({
    repoRoot: sourceRoot,
    target,
    legacyLanguages: options.legacyLanguages || [],
  });

  return createManifestInstallPlan({
    sourceRoot,
    projectRoot,
    homeDir: options.homeDir,
    target,
    profileId: null,
    moduleIds: selection.moduleIds,
    includeComponentIds: [],
    excludeComponentIds: [],
    legacyLanguages: selection.legacyLanguages,
    legacyMode: true,
    requestProfileId: null,
    requestModuleIds: [],
    requestIncludeComponentIds: [],
    requestExcludeComponentIds: [],
    mode: 'legacy-compat',
  });
}

function materializeScaffoldOperation(sourceRoot, operation) {
  if (operation.kind === HOOK_OPERATION_KIND) {
    return [{ ...operation, scaffoldOnly: false }];
  }

  if (operation.kind === MERGE_YAML_READ_LIST_KIND) {
    return [{ ...operation, scaffoldOnly: false }];
  }

  if (operation.kind === MERGE_MARKDOWN_INDEX_KIND) {
    return [{ ...operation, scaffoldOnly: false }];
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

  for (const operation of operations) {
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

// The value when it is an array, an empty one otherwise.
function toValidationIssueArray(value) {
  return Array.isArray(value) ? value : [];
}

// A list the install request records as the caller gave it: the request*
// field when the caller set one, else the plain field, copied either way.
function requestIds(options, requestKey, plainKey) {
  if (Object.hasOwn(options, requestKey)) return [...options[requestKey]];
  return Array.isArray(options[plainKey]) ? [...options[plainKey]] : [];
}

function createManifestInstallPlan(options = {}) {
  const sourceRoot = options.sourceRoot || getSourceRoot();
  const projectRoot = options.projectRoot || process.cwd();
  const target = options.target || 'egc';
  const legacyLanguages = Array.isArray(options.legacyLanguages)
    ? [...options.legacyLanguages]
    : [];
  const requestProfileId = Object.hasOwn(options, 'requestProfileId')
    ? options.requestProfileId
    : (options.profileId || null);
  const requestModuleIds = requestIds(options, 'requestModuleIds', 'moduleIds');
  const requestIncludeComponentIds = requestIds(options, 'requestIncludeComponentIds', 'includeComponentIds');
  const requestExcludeComponentIds = requestIds(options, 'requestExcludeComponentIds', 'excludeComponentIds');
  const plan = resolveInstallPlan({
    repoRoot: sourceRoot,
    projectRoot,
    homeDir: options.homeDir,
    profileId: options.profileId || null,
    moduleIds: options.moduleIds || [],
    includeComponentIds: options.includeComponentIds || [],
    excludeComponentIds: options.excludeComponentIds || [],
    target,
  });
  const adapter = getInstallTargetAdapter(target);
  const operations = dedupeCopyFileDestinations(
    plan.operations.flatMap(operation => materializeScaffoldOperation(sourceRoot, operation)),
    adapter.nativeRootRelativePath
  );
  const source = {
    repoVersion: getPackageVersion(sourceRoot),
    repoCommit: getRepoCommit(sourceRoot),
    manifestVersion: getManifestVersion(sourceRoot),
  };
  const statePreview = createStatePreview({
    adapter,
    targetRoot: plan.targetRoot,
    installStatePath: plan.installStatePath,
    request: {
      profile: requestProfileId,
      modules: requestModuleIds,
      includeComponents: requestIncludeComponentIds,
      excludeComponents: requestExcludeComponentIds,
      legacyLanguages,
      legacyMode: Boolean(options.legacyMode),
    },
    resolution: {
      selectedModules: plan.selectedModuleIds,
      skippedModules: plan.skippedModuleIds,
    },
    operations,
    source,
  });

  return {
    mode: options.mode || 'manifest',
    target,
    adapter: {
      id: adapter.id,
      target: adapter.target,
      kind: adapter.kind,
    },
    targetRoot: plan.targetRoot,
    installRoot: plan.targetRoot,
    installStatePath: plan.installStatePath,
    retirements: toValidationIssueArray(plan.retirements),
    hookRetirements: toValidationIssueArray(plan.hookRetirements),
    managedRoots: toValidationIssueArray(plan.managedRoots),
    // The structured issues ride along untouched: the CLI's detection gate
    // needs the machine-readable code (ide-not-detected), not just the
    // flattened warning strings below.
    validationIssues: toValidationIssueArray(plan.validationIssues),
    warnings: [
      ...(Array.isArray(options.warnings) ? options.warnings : []),
      ...(Array.isArray(plan.validationIssues)
        ? plan.validationIssues
            .filter(issue => issue.severity === 'warning')
            .map(issue => issue.message)
        : []),
    ],
    languages: legacyLanguages,
    legacyLanguages,
    profileId: plan.profileId,
    requestedModuleIds: plan.requestedModuleIds,
    explicitModuleIds: plan.explicitModuleIds,
    includedComponentIds: plan.includedComponentIds,
    excludedComponentIds: plan.excludedComponentIds,
    selectedModuleIds: plan.selectedModuleIds,
    skippedModuleIds: plan.skippedModuleIds,
    excludedModuleIds: plan.excludedModuleIds,
    operations,
    statePreview,
  };
}

module.exports = {
  SUPPORTED_INSTALL_TARGETS,
  LEGACY_INSTALL_TARGETS,
  applyInstallPlan,
  createLegacyCompatInstallPlan,
  createManifestInstallPlan,
  createLegacyInstallPlan,
  getSourceRoot,
  listAvailableLanguages,
  listFilesRecursive,
  parseInstallArgs,
};
