const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { toCursorAgentRelativePath } = require('../cursor-agent-names');
const { LEGACY_INSTALL_TARGETS } = require('./request');
const { getInstallTargetAdapter } = require('../install-targets/registry');
const {
  addFileCopyOperation,
  addJsonMergeOperation,
  addMatchingRuleOperations,
  addRecursiveCopyOperations,
  isDirectoryNonEmpty,
} = require('./plan-operations');
const {
  createStatePreview,
  getManifestVersion,
  getPackageVersion,
  getRepoCommit,
  getSourceRoot,
} = require('./plan-source');

// The legacy install plans: rules-only installs for the egc, cursor and
// antigravity targets.

const LANGUAGE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const GEMINI_EGC_NAMESPACE = 'egc';

function validateLegacyTarget(target) {
  if (!LEGACY_INSTALL_TARGETS.includes(target)) {
    throw new Error(
      `Unknown install target: ${target}. Expected one of ${LEGACY_INSTALL_TARGETS.join(', ')}`
    );
  }
}

function planEGCLegacyInstall(context) {
  const adapter = getInstallTargetAdapter('egc');
  const targetRoot = adapter.resolveRoot({ homeDir: context.homeDir });
  const rulesDir = context.geminiRulesDir || path.join(targetRoot, 'rules', GEMINI_EGC_NAMESPACE);
  const installStatePath = adapter.getInstallStatePath({ homeDir: context.homeDir });
  const operations = [];
  const warnings = [];

  if (isDirectoryNonEmpty(rulesDir)) {
    warnings.push(
      `Destination ${rulesDir}/ already exists and files may be overwritten`
    );
  }

  addRecursiveCopyOperations(operations, {
    moduleId: 'legacy-egc-rules',
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
      moduleId: 'legacy-egc-rules',
      sourceRoot: context.sourceRoot,
      sourceRelativeDir: path.join('rules', language),
      destinationDir: path.join(rulesDir, language),
    });
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

module.exports = {
  createLegacyInstallPlan,
  validateLegacyTarget,
};
