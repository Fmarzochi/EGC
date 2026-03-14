const fs = require('fs');
const path = require('path');

const { resolveInstallPlan, loadInstallManifests } = require('./install-manifests');
const { readInstallState, writeInstallState } = require('./install-state');
const {
  applyInstallPlan,
  createLegacyInstallPlan,
  createManifestInstallPlan,
} = require('./install-executor');
const {
  getInstallTargetAdapter,
  listInstallTargetAdapters,
} = require('./install-targets/registry');

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

function inspectManagedOperation(repoRoot, operation) {
  const destinationPath = operation.destinationPath;
  if (!destinationPath) {
    return {
      status: 'invalid-destination',
      operation,
    };
  }

  if (!fs.existsSync(destinationPath)) {
    return {
      status: 'missing',
      operation,
      destinationPath,
    };
  }

  if (operation.kind !== 'copy-file') {
    return {
      status: 'unverified',
      operation,
      destinationPath,
    };
  }

  const sourcePath = resolveOperationSourcePath(repoRoot, operation);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return {
      status: 'missing-source',
      operation,
      destinationPath,
      sourcePath,
    };
  }

  if (!areFilesEqual(sourcePath, destinationPath)) {
    return {
      status: 'drifted',
      operation,
      destinationPath,
      sourcePath,
    };
  }

  return {
    status: 'ok',
    operation,
    destinationPath,
    sourcePath,
  };
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
    homeDir: options.homeDir || process.env.HOME,
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

function analyzeRecord(record, context) {
  const issues = [];

  if (record.error) {
    issues.push(buildIssue('error', 'invalid-install-state', record.error));
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
      issues,
    };
  }

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

  const managedOperations = getManagedOperations(state);
  const operationHealth = summarizeManagedOperationHealth(context.repoRoot, managedOperations);
  const missingManagedOperations = operationHealth.missing;

  if (missingManagedOperations.length > 0) {
    issues.push(buildIssue(
      'error',
      'missing-managed-files',
      `${missingManagedOperations.length} managed file(s) are missing`,
      {
        paths: missingManagedOperations.map(entry => entry.destinationPath),
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

  if (!state.request.legacyMode) {
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
        issues.push(buildIssue(
          'warning',
          'resolution-drift',
          'Current manifest resolution differs from recorded install-state',
          {
            expectedSelectedModules: desiredPlan.selectedModuleIds,
            recordedSelectedModules: state.resolution.selectedModules,
            expectedSkippedModules: desiredPlan.skippedModuleIds,
            recordedSkippedModules: state.resolution.skippedModules,
          }
        ));
      }
    } catch (error) {
      issues.push(buildIssue(
        'error',
        'resolution-unavailable',
        error.message
      ));
    }
  }

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
    homeDir: options.homeDir || process.env.HOME,
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

  if (state.request.legacyMode) {
    const operations = getManagedOperations(state).map(operation => ({
      ...operation,
      sourcePath: resolveOperationSourcePath(context.repoRoot, operation),
    }));

    const statePreview = {
      ...state,
      operations: operations.map(operation => ({ ...operation })),
      source: {
        ...state.source,
        repoVersion: context.packageVersion,
        manifestVersion: context.manifestVersion,
      },
      lastValidatedAt: new Date().toISOString(),
    };

    return {
      mode: 'legacy',
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
    homeDir: options.homeDir || process.env.HOME,
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
        applyInstallPlan({
          ...desiredPlan,
          operations: repairOperations,
          statePreview: desiredPlan.statePreview,
        });
      } else {
        writeInstallState(desiredPlan.installStatePath, desiredPlan.statePreview);
      }

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
      const filePaths = Array.from(new Set(
        getManagedOperations(state).map(operation => operation.destinationPath)
      )).sort((left, right) => right.length - left.length);

      for (const filePath of filePaths) {
        if (!fs.existsSync(filePath)) {
          continue;
        }

        const stat = fs.lstatSync(filePath);
        if (stat.isDirectory()) {
          throw new Error(`Refusing to remove managed directory path without explicit support: ${filePath}`);
        }

        fs.rmSync(filePath, { force: true });
        removedPaths.push(filePath);
        cleanupTargets.push(filePath);
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
