const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isIgnoredSourceDirectory, isIgnoredSourceFile } = require('../install-source-filters');

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
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, ''); // NOSONAR: superlinear risk accepted: input is repo-owned or local state content, never network-controlled
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

// Every adapter's planOperations(input, adapter) accepts either a `modules`
// array (the shape registry.js's planInstallTargetScaffold always normalizes
// to before calling in) or a single `module` object (the shape a caller that
// invokes adapter.planOperations() directly, bypassing the registry, may
// still pass -- see the "singular input.module" test coverage in
// install-targets.test.js). This normalization was duplicated verbatim
// across nine adapter files plus twice more inside this file itself
// (createFlatSkillPlanOperations and createDefaultScaffoldOperations) before
// being consolidated here (EGC-539 audit).
function normalizeModulesInput(input = {}) {
  if (Array.isArray(input.modules)) {
    return input.modules;
  }

  if (input.module) {
    return [input.module];
  }

  return [];
}

// The normalizeModulesInput() call plus the repoRoot/projectRoot/homeDir
// planningInput shape plus the adapter.resolveRoot(planningInput) call were
// identical across claude-home.js, codex-home.js, gemini-home.js, and
// opencode-home.js's planOperations -- each rebuilding the same 3-value
// lookup before diverging into its own module-to-operation mapping.
// Collapsing normalizeModulesInput() alone (above) into a 1-line call
// elsewhere in this same audit round made this remaining prefix contiguous
// enough to cross SonarCloud's cross-file duplication threshold (EGC-539
// audit, PR #1150). Only these three values are pulled out -- adapters that
// need extra planningInput fields (e.g. cursor-project.js's
// seenDestinationPaths) or a different root-resolution path keep their own
// inline version rather than being forced through this.
function resolveModulesPlan(input, adapter) {
  const modules = normalizeModulesInput(input);
  const planningInput = {
    repoRoot: input.repoRoot,
    projectRoot: input.projectRoot,
    homeDir: input.homeDir,
  };
  const targetRoot = adapter.resolveRoot(planningInput);
  return { modules, planningInput, targetRoot };
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

    // Same artifact exclusions as install-executor.js's listFilesRecursive:
    // adapter plans enumerate sources through this path too, and a local
    // .DS_Store or __pycache__ must never become a managed install source.
    if (entry.isDirectory()) {
      if (isIgnoredSourceDirectory(entry.name)) {
        continue;
      }
      files.push(...listRelativeFiles(absolutePath, entryPrefix));
    } else if (entry.isFile() && !isIgnoredSourceFile(entry.name)) {
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
 junie:         { name: 'Junie', url: 'https://www.jetbrains.com/junie/' },
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

function createFlatFileOperations({ // NOSONAR: directory walk building install operations kept inline; branches mirror the layout rules
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

    // Same artifact exclusions as the nested listRelativeFiles walk: a
    // top-level __pycache__ namespace or a stray .DS_Store directly under
    // the source root must never become a managed install source either.
    if (entry.isDirectory() && !isIgnoredSourceDirectory(entry.name)) {
      const relativeFiles = listRelativeFiles(entryPath);
      for (const relativeFile of relativeFiles) {
        const defaultFileName = `${namespace}-${normalizeRelativePath(relativeFile).replaceAll('/', '-')}`;
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
    } else if (entry.isFile() && !isIgnoredSourceFile(entry.name)) {
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
function createFlatSkillPlanOperations(rawInput, adapter) {
  const input = rawInput ?? {};
  const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);

  return modules.flatMap(module => {
    const paths = Array.isArray(module.paths) ? module.paths : [];
    return paths
      .filter(p => !isForeignPlatformPath(p, adapter.target))
      .map(sourceRelativePath => planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot));
  });
}

// Same default-scaffold behavior createInstallTargetAdapter would otherwise
// supply on its own (preserve category structure, no flat stripping) --
// factored out so every adapter that defines a custom planOperations (to
// also emit its own extra operations alongside the default scaffold, e.g.
// Amazon Q/Roo Code's Guardian wiring) can reuse it instead of each keeping
// its own copy. Was duplicated verbatim across amazonq-project.js and
// roocode-project.js before this (SonarCloud new-code duplication finding
// on PR #1122); consolidated here as the single source of truth.
function createDefaultScaffoldOperations(input, adapter) {
  return normalizeModulesInput(input).flatMap(module => {
    const paths = Array.isArray(module.paths) ? module.paths : [];
    return paths
      .filter(p => !isForeignPlatformPath(p, adapter.target))
      .map(sourceRelativePath => adapter.createScaffoldOperation(module.id, sourceRelativePath, input));
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

      // Same body createDefaultScaffoldOperations exposes for adapters that
      // define a custom planOperations of their own -- this default branch
      // used to keep an unreduced copy of the exact same logic (EGC-539
      // audit) instead of calling that already-extracted helper.
      return createDefaultScaffoldOperations(input, adapter);
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
  createDefaultScaffoldOperations,
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
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeModulesInput,
  normalizeRelativePath,
  planFlatSkillOperation,
  resolveModulesPlan,
};
