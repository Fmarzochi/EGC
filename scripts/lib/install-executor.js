const fs = require('node:fs');
const path = require('node:path');

const { LEGACY_INSTALL_TARGETS, parseInstallArgs } = require('./install/request');
const {
  SUPPORTED_INSTALL_TARGETS,
  listLegacyCompatibilityLanguages,
  resolveLegacyCompatibilitySelection,
  resolveInstallPlan,
} = require('./install-manifests');
const { getInstallTargetAdapter } = require('./install-targets/registry');
const { createLegacyInstallPlan, validateLegacyTarget } = require('./install/legacy-plans');
const {
  dedupeCopyFileDestinations,
  listFilesRecursive,
  materializeScaffoldOperation,
} = require('./install/plan-operations');
const {
  createStatePreview,
  getManifestVersion,
  getPackageVersion,
  getRepoCommit,
  getSourceRoot,
} = require('./install/plan-source');

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

function applyInstallPlan(plan) {
  const { applyInstallPlan: applyPlan } = require('./install/apply');
  return applyPlan(plan);
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
