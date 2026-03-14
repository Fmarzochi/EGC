const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { applyInstallPlan } = require('./install/apply');
const { LEGACY_INSTALL_TARGETS, parseInstallArgs } = require('./install/request');
const {
  SUPPORTED_INSTALL_TARGETS,
  resolveInstallPlan,
} = require('./install-manifests');
const { getInstallTargetAdapter } = require('./install-targets/registry');
const { createInstallState } = require('./install-state');

const LANGUAGE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const EXCLUDED_GENERATED_SOURCE_SUFFIXES = [
  '/ecc-install-state.json',
  '/ecc/install-state.json',
];

function getSourceRoot() {
  return path.join(__dirname, '../..');
}

function getPackageVersion(sourceRoot) {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')
    );
    return packageJson.version || null;
  } catch (_error) {
    return null;
  }
}

function getManifestVersion(sourceRoot) {
  try {
    const modulesManifest = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, 'manifests', 'install-modules.json'), 'utf8')
    );
    return modulesManifest.version || 1;
  } catch (_error) {
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
  } catch (_error) {
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
    .sort();
}

function listAvailableLanguages(sourceRoot = getSourceRoot()) {
  return readDirectoryNames(path.join(sourceRoot, 'rules'))
    .filter(name => name !== 'common');
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
      const childFiles = listFilesRecursive(absolutePath);
      for (const childFile of childFiles) {
        files.push(path.join(entry.name, childFile));
      }
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }

  return files.sort();
}

function isGeneratedRuntimeSourcePath(sourceRelativePath) {
  const normalizedPath = String(sourceRelativePath || '').replace(/\\/g, '/');
  return EXCLUDED_GENERATED_SOURCE_SUFFIXES.some(suffix => normalizedPath.endsWith(suffix));
}

function buildCopyFileOperation({ moduleId, sourcePath, sourceRelativePath, destinationPath, strategy }) {
  return {
    kind: 'copy-file',
    moduleId,
    sourcePath,
    sourceRelativePath,
    destinationPath,
    strategy,
    ownership: 'managed',
    scaffoldOnly: false,
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
    const destinationPath = path.join(options.destinationDir, relativeFile);
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

function addMatchingRuleOperations(operations, options) {
  const sourceDir = path.join(options.sourceRoot, options.sourceRelativeDir);
  if (!fs.existsSync(sourceDir)) {
    return 0;
  }

  const files = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && options.matcher(entry.name))
    .map(entry => entry.name)
    .sort();

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

function planClaudeLegacyInstall(context) {
  const adapter = getInstallTargetAdapter('claude');
  const targetRoot = adapter.resolveRoot({ homeDir: context.homeDir });
  const rulesDir = context.claudeRulesDir || path.join(targetRoot, 'rules');
  const installStatePath = adapter.getInstallStatePath({ homeDir: context.homeDir });
  const operations = [];
  const warnings = [];

  if (isDirectoryNonEmpty(rulesDir)) {
    warnings.push(
      `Destination ${rulesDir}/ already exists and files may be overwritten`
    );
  }

  addRecursiveCopyOperations(operations, {
    moduleId: 'legacy-claude-rules',
    sourceRoot: context.sourceRoot,
    sourceRelativeDir: path.join('rules', 'common'),
    destinationDir: path.join(rulesDir, 'common'),
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

    addRecursiveCopyOperations(operations, {
      moduleId: 'legacy-claude-rules',
      sourceRoot: context.sourceRoot,
      sourceRelativeDir: path.join('rules', language),
      destinationDir: path.join(rulesDir, language),
    });
  }

  return {
    mode: 'legacy',
    adapter,
    target: 'claude',
    targetRoot,
    installRoot: rulesDir,
    installStatePath,
    operations,
    warnings,
    selectedModules: ['legacy-claude-rules'],
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
  addFileCopyOperation(operations, {
    moduleId: 'legacy-cursor-install',
    sourceRoot: context.sourceRoot,
    sourceRelativePath: path.join('.cursor', 'mcp.json'),
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
  addRecursiveCopyOperations(operations, {
    moduleId: 'legacy-antigravity-install',
    sourceRoot: context.sourceRoot,
    sourceRelativeDir: 'agents',
    destinationDir: path.join(targetRoot, 'skills'),
  });
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
  const homeDir = options.homeDir || process.env.HOME;
  const target = options.target || 'claude';

  validateLegacyTarget(target);

  const context = {
    sourceRoot,
    projectRoot,
    homeDir,
    languages: Array.isArray(options.languages) ? options.languages : [],
    claudeRulesDir: options.claudeRulesDir || process.env.CLAUDE_RULES_DIR || null,
  };

  let plan;
  if (target === 'claude') {
    plan = planClaudeLegacyInstall(context);
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

  const statePreview = createInstallState({
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

function materializeScaffoldOperation(sourceRoot, operation) {
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
    })];
  }

  const relativeFiles = listFilesRecursive(sourcePath).filter(relativeFile => {
    const sourceRelativePath = path.join(operation.sourceRelativePath, relativeFile);
    return !isGeneratedRuntimeSourcePath(sourceRelativePath);
  });
  return relativeFiles.map(relativeFile => {
    const sourceRelativePath = path.join(operation.sourceRelativePath, relativeFile);
    return buildCopyFileOperation({
      moduleId: operation.moduleId,
      sourcePath: path.join(sourcePath, relativeFile),
      sourceRelativePath,
      destinationPath: path.join(operation.destinationPath, relativeFile),
      strategy: operation.strategy,
    });
  });
}

function createManifestInstallPlan(options = {}) {
  const sourceRoot = options.sourceRoot || getSourceRoot();
  const projectRoot = options.projectRoot || process.cwd();
  const target = options.target || 'claude';
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
  const operations = plan.operations.flatMap(operation => materializeScaffoldOperation(sourceRoot, operation));
  const source = {
    repoVersion: getPackageVersion(sourceRoot),
    repoCommit: getRepoCommit(sourceRoot),
    manifestVersion: getManifestVersion(sourceRoot),
  };
  const statePreview = createInstallState({
    adapter,
    targetRoot: plan.targetRoot,
    installStatePath: plan.installStatePath,
    request: {
      profile: plan.profileId,
      modules: Array.isArray(options.moduleIds) ? [...options.moduleIds] : [],
      includeComponents: Array.isArray(options.includeComponentIds)
        ? [...options.includeComponentIds]
        : [],
      excludeComponents: Array.isArray(options.excludeComponentIds)
        ? [...options.excludeComponentIds]
        : [],
      legacyLanguages: [],
      legacyMode: false,
    },
    resolution: {
      selectedModules: plan.selectedModuleIds,
      skippedModules: plan.skippedModuleIds,
    },
    operations,
    source,
  });

  return {
    mode: 'manifest',
    target,
    adapter: {
      id: adapter.id,
      target: adapter.target,
      kind: adapter.kind,
    },
    targetRoot: plan.targetRoot,
    installRoot: plan.targetRoot,
    installStatePath: plan.installStatePath,
    warnings: [],
    languages: [],
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
  createManifestInstallPlan,
  createLegacyInstallPlan,
  getSourceRoot,
  listAvailableLanguages,
  parseInstallArgs,
};
