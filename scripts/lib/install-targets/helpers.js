const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLATFORM_SOURCE_PATH_OWNERS = Object.freeze({
  '.gemini-plugin': 'egc',
  '.codex': 'codex',
  '.cursor': 'cursor',
  '.gemini': 'gemini',
  '.opencode': 'opencode',
  '.codebuddy': 'codebuddy',
});

function normalizeRelativePath(relativePath) {
  return String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

function isForeignPlatformPath(sourceRelativePath, adapterTarget) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);

  for (const [prefix, ownerTarget] of Object.entries(PLATFORM_SOURCE_PATH_OWNERS)) {
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      return ownerTarget !== adapterTarget;
    }
  }

  return false;
}

function resolveBaseRoot(scope, input = {}) {
  if (scope === 'home') {
    return input.homeDir || os.homedir();
  }

  if (scope === 'project') {
    const projectRoot = input.projectRoot || input.repoRoot;
    if (!projectRoot) {
      throw new Error('projectRoot or repoRoot is required for project install targets');
    }
    return projectRoot;
  }

  throw new Error(`Unsupported install target scope: ${scope}`);
}

function buildValidationIssue(severity, code, message, extra = {}) {
  return {
    severity,
    code,
    message,
    ...extra,
  };
}

function listRelativeFiles(dirPath, prefix = '') {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((left, right) => (
    left.name.localeCompare(right.name)
  ));
  const files = [];

  for (const entry of entries) {
    const entryPrefix = prefix ? path.join(prefix, entry.name) : entry.name;
    const absolutePath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(absolutePath, entryPrefix));
    } else if (entry.isFile()) {
      files.push(normalizeRelativePath(entryPrefix));
    }
  }

  return files;
}

function createManagedOperation({
  kind = 'copy-path',
  moduleId,
  sourceRelativePath,
  destinationPath,
  strategy = 'preserve-relative-path',
  ownership = 'managed',
  scaffoldOnly = true,
  ...rest
}) {
  return {
    kind,
    moduleId,
    sourceRelativePath: normalizeRelativePath(sourceRelativePath),
    destinationPath,
    strategy,
    ownership,
    scaffoldOnly,
    ...rest,
  };
}

const IDE_INSTALL_URLS = Object.freeze({
  claude:       { name: 'Claude Code',        url: 'https://claude.ai/download' },
  cursor:       { name: 'Cursor',             url: 'https://cursor.sh' },
  gemini:       { name: 'Gemini CLI',         url: 'https://github.com/google-gemini/gemini-cli' },
  antigravity:  { name: 'Antigravity CLI',    url: 'https://github.com/google-gemini/gemini-cli' },
  codex:        { name: 'Codex CLI',          url: 'https://github.com/openai/codex' },
  opencode:     { name: 'OpenCode',           url: 'https://opencode.ai' },
  codebuddy:    { name: 'CodeBuddy',          url: 'https://copilot.tencent.com' },
  kiro:         { name: 'Kiro',               url: 'https://kiro.dev' },
  trae:         { name: 'Trae',               url: 'https://www.trae.ai' },
  goose:        { name: 'Goose',              url: 'https://block.github.io/goose/' },
  amazonq:      { name: 'Amazon Q Developer CLI', url: 'https://aws.amazon.com/q/developer/' },
  openhands:    { name: 'OpenHands',          url: 'https://docs.openhands.dev' },
  aider:        { name: 'Aider',              url: 'https://aider.chat' },
  warp:         { name: 'Warp',               url: 'https://www.warp.dev' },
  windsurf:     { name: 'Windsurf',           url: 'https://windsurf.ai' },
  amp:          { name: 'Amp',                url: 'https://ampcode.com' },
  copilot:      { name: 'VS Code Copilot',    url: 'https://code.visualstudio.com' },
  zed:          { name: 'Zed',               url: 'https://zed.dev' },
  continue:     { name: 'Continue.dev',      url: 'https://continue.dev' },
});

function defaultValidateAdapterInput(config, input = {}) {
  if (config.kind === 'project' && !input.projectRoot && !input.repoRoot) {
    return [
      buildValidationIssue(
        'error',
        'missing-project-root',
        'projectRoot or repoRoot is required for project install targets'
      ),
    ];
  }

  if (config.kind === 'home' && !input.homeDir && !os.homedir()) {
    return [
      buildValidationIssue(
        'error',
        'missing-home-dir',
        'homeDir is required for home install targets'
      ),
    ];
  }

  const issues = [];
  const baseRoot = config.kind === 'home'
    ? (input.homeDir || os.homedir())
    : (input.projectRoot || input.repoRoot);

  if (baseRoot && config.rootSegments && config.rootSegments.length > 0) {
    const rootDir = path.join(baseRoot, config.rootSegments[0]);
    if (!fs.existsSync(rootDir)) {
      const ide = IDE_INSTALL_URLS[config.target];
      if (ide) {
        issues.push(buildValidationIssue(
          'warning',
          'ide-not-detected',
          `${ide.name} does not appear to be installed on this machine.\n` +
          `  Expected config directory not found: ${rootDir}\n` +
          `  To install ${ide.name}, visit: ${ide.url}`
        ));
      }
    }
  }

  return issues;
}

function createRemappedOperation(adapter, moduleId, sourceRelativePath, destinationPath, options = {}) {
  return createManagedOperation({
    kind: options.kind || 'copy-path',
    moduleId,
    sourceRelativePath,
    destinationPath,
    strategy: options.strategy || 'preserve-relative-path',
    ownership: options.ownership || 'managed',
    scaffoldOnly: Object.hasOwn(options, 'scaffoldOnly') ? options.scaffoldOnly : true,
    ...options.extra,
  });
}

function createNamespacedFlatRuleOperations(adapter, moduleId, sourceRelativePath, input = {}) {
  const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
  const sourceRoot = path.join(input.repoRoot || '', normalizedSourcePath);

  if (!input.repoRoot || !fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    return [];
  }

  const targetRulesDir = path.join(adapter.resolveRoot(input), 'rules');
  const operations = [];
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true }).sort((left, right) => (
    left.name.localeCompare(right.name)
  ));

  for (const entry of entries) {
    const namespace = entry.name;
    const entryPath = path.join(sourceRoot, entry.name);

    if (entry.isDirectory()) {
      const relativeFiles = listRelativeFiles(entryPath);
      for (const relativeFile of relativeFiles) {
        const flattenedFileName = `${namespace}-${normalizeRelativePath(relativeFile).replace(/\//g, '-')}`;
        const sourceRelativeFile = path.join(normalizedSourcePath, namespace, relativeFile);
        operations.push(createManagedOperation({
          moduleId,
          sourceRelativePath: sourceRelativeFile,
          destinationPath: path.join(targetRulesDir, flattenedFileName),
          strategy: 'flatten-copy',
        }));
      }
    } else if (entry.isFile()) {
      operations.push(createManagedOperation({
        moduleId,
        sourceRelativePath: path.join(normalizedSourcePath, entry.name),
        destinationPath: path.join(targetRulesDir, entry.name),
        strategy: 'flatten-copy',
      }));
    }
  }

  return operations;
}

function createFlatFileOperations({
  moduleId,
  repoRoot,
  sourceRelativePath,
  destinationDir,
  destinationNameTransform,
}) {
  const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
  const sourceRoot = path.join(repoRoot || '', normalizedSourcePath);

  if (!repoRoot || !fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    return [];
  }

  const operations = [];
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true }).sort((left, right) => (
    left.name.localeCompare(right.name)
  ));

  for (const entry of entries) {
    const namespace = entry.name;
    const entryPath = path.join(sourceRoot, entry.name);

    if (entry.isDirectory()) {
      const relativeFiles = listRelativeFiles(entryPath);
      for (const relativeFile of relativeFiles) {
        const defaultFileName = `${namespace}-${normalizeRelativePath(relativeFile).replace(/\//g, '-')}`;
        const sourceRelativeFile = path.join(normalizedSourcePath, namespace, relativeFile);
        const flattenedFileName = typeof destinationNameTransform === 'function'
          ? destinationNameTransform(defaultFileName, sourceRelativeFile)
          : defaultFileName;
        if (!flattenedFileName) {
          continue;
        }
        operations.push(createManagedOperation({
          moduleId,
          sourceRelativePath: sourceRelativeFile,
          destinationPath: path.join(destinationDir, flattenedFileName),
          strategy: 'flatten-copy',
        }));
      }
    } else if (entry.isFile()) {
      const sourceRelativeFile = path.join(normalizedSourcePath, entry.name);
      const destinationFileName = typeof destinationNameTransform === 'function'
        ? destinationNameTransform(entry.name, sourceRelativeFile)
        : entry.name;
      if (!destinationFileName) {
        continue;
      }
      operations.push(createManagedOperation({
        moduleId,
        sourceRelativePath: sourceRelativeFile,
        destinationPath: path.join(destinationDir, destinationFileName),
        strategy: 'flatten-copy',
      }));
    }
  }

  return operations;
}

function createFlatRuleOperations(options) {
  return createFlatFileOperations(options);
}

/**
 * Builds the install operation for a single module source path on a target
 * whose native skill layout is flat (<root>/skills/<name>/, no category
 * subfolder). Skill sources are remapped from skills/<category>/<name> to
 * skills/<name>; every other path scaffolds through the adapter's default
 * strategy. This is the one piece every flat-skill adapter shares -
 * including Claude Code's, which layers its own extra path filter and
 * hook-operation append around it - so it lives here instead of being
 * copied into each adapter file.
 */
function planFlatSkillOperation(adapter, moduleId, sourceRelativePath, planningInput, targetRoot) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);

  if (normalizedPath.startsWith('skills/')) {
    const parts = normalizedPath.slice('skills/'.length).split('/');
    const flatRemainder = parts.length >= 2 ? parts.slice(1).join('/') : parts.join('/');
    return createRemappedOperation(
      adapter,
      moduleId,
      sourceRelativePath,
      path.join(targetRoot, 'skills', flatRemainder),
      { strategy: 'preserve-relative-path' }
    );
  }

  return adapter.createScaffoldOperation(moduleId, sourceRelativePath, planningInput);
}

/**
 * Shared planOperations body for Tier 1 targets that discover skills flat
 * and have no adapter-specific path filtering or extra operations beyond
 * planFlatSkillOperation (Windsurf, Amp, Copilot, Zed, Continue.dev).
 *
 * Signature matches config.planOperations(input, adapter) so it can be
 * assigned directly (e.g. `planOperations: createFlatSkillPlanOperations`)
 * without a wrapper closure in each adapter file.
 */
function createFlatSkillPlanOperations(input = {}, adapter) {
  let modules;
  if (Array.isArray(input.modules)) {
    modules = input.modules;
  } else if (input.module) {
    modules = [input.module];
  } else {
    modules = [];
  }
  const planningInput = {
    repoRoot: input.repoRoot,
    projectRoot: input.projectRoot,
    homeDir: input.homeDir,
  };
  const targetRoot = adapter.resolveRoot(planningInput);

  return modules.flatMap(module => {
    const paths = Array.isArray(module.paths) ? module.paths : [];
    return paths
      .filter(p => !isForeignPlatformPath(p, adapter.target))
      .map(sourceRelativePath => planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot));
  });
}

function createInstallTargetAdapter(config) {
  const adapter = {
    id: config.id,
    target: config.target,
    kind: config.kind,
    nativeRootRelativePath: config.nativeRootRelativePath || null,
    supports(target) {
      return target === config.target || target === config.id;
    },
    resolveRoot(input = {}) {
      const baseRoot = resolveBaseRoot(config.kind, input);
      return path.join(baseRoot, ...config.rootSegments);
    },
    getInstallStatePath(input = {}) {
      const root = adapter.resolveRoot(input);
      return path.join(root, ...config.installStatePathSegments);
    },
    resolveDestinationPath(sourceRelativePath, input = {}) {
      const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
      const targetRoot = adapter.resolveRoot(input);

      if (
        config.nativeRootRelativePath
        && normalizedSourcePath === normalizeRelativePath(config.nativeRootRelativePath)
      ) {
        return targetRoot;
      }

      return path.join(targetRoot, normalizedSourcePath);
    },
    determineStrategy(sourceRelativePath) {
      const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);

      if (
        config.nativeRootRelativePath
        && normalizedSourcePath === normalizeRelativePath(config.nativeRootRelativePath)
      ) {
        return 'sync-root-children';
      }

      return 'preserve-relative-path';
    },
    createScaffoldOperation(moduleId, sourceRelativePath, input = {}) {
      const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
      return createManagedOperation({
        moduleId,
        sourceRelativePath: normalizedSourcePath,
        destinationPath: adapter.resolveDestinationPath(normalizedSourcePath, input),
        strategy: adapter.determineStrategy(normalizedSourcePath),
      });
    },
    planOperations(input = {}) {
      if (typeof config.planOperations === 'function') {
        return config.planOperations(input, adapter);
      }

      if (Array.isArray(input.modules)) {
        return input.modules.flatMap(module => {
          const paths = Array.isArray(module.paths) ? module.paths : [];
          return paths
            .filter(p => !isForeignPlatformPath(p, config.target))
            .map(sourceRelativePath => adapter.createScaffoldOperation(
              module.id,
              sourceRelativePath,
              input
            ));
        });
      }

      const module = input.module || {};
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(p => !isForeignPlatformPath(p, config.target))
        .map(sourceRelativePath => adapter.createScaffoldOperation(
          module.id,
          sourceRelativePath,
          input
        ));
    },
    supportsModule(module, input = {}) {
      if (typeof config.supportsModule === 'function') {
        return config.supportsModule(module, input, adapter);
      }

      return true;
    },
    validate(input = {}) {
      if (typeof config.validate === 'function') {
        return config.validate(input, adapter);
      }

      return defaultValidateAdapterInput(config, input);
    },
  };

  return Object.freeze(adapter);
}

module.exports = {
  buildValidationIssue,
  createFlatFileOperations,
  createFlatRuleOperations,
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createManagedOperation,
  createManagedScaffoldOperation: (moduleId, sourceRelativePath, destinationPath, strategy) => (
    createManagedOperation({
      moduleId,
      sourceRelativePath,
      destinationPath,
      strategy,
    })
  ),
  createNamespacedFlatRuleOperations,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
  planFlatSkillOperation,
};
