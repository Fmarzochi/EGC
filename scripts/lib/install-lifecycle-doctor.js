'use strict';

// Discovery of installed states and the doctor report built from their health checks.
// Part of the install-lifecycle.js split; that file re-exports the public surface.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveInstallPlan, loadInstallManifests } = require('./install-manifests');
const { readInstallState } = require('./install-state');
const { listInstallTargetAdapters } = require('./install-targets/registry');
const { resolveAdapterManagedRoots } = require('./install-targets/helpers');
const { HOOK_OPERATION_KIND } = require('./claude-settings-hooks');
const { shellQuote } = require('./doctor-summary');
const {
  DEFAULT_REPO_ROOT,
  readPackageVersion,
  normalizeTargets,
  compareStringArrays,
  getManagedOperations,
} = require('./install-lifecycle-core');
const { summarizeManagedOperationHealth } = require('./install-lifecycle-inspect');

function isInsideRoot(candidatePath, root) {
  const relative = path.relative(root, candidatePath);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// The state a record describes: the current one when it is there; else the
// first legacy state the adapter still answers for (written under a root it
// no longer picks), reported with the root that state lives under so the
// record stays consistent with its own file; else the current path, absent.
function locateInstallState(adapter, input) {
  const currentRoot = adapter.resolveRoot(input);
  const currentStatePath = adapter.getInstallStatePath(input);
  if (fs.existsSync(currentStatePath)) {
    return { targetRoot: currentRoot, installStatePath: currentStatePath, exists: true };
  }
  const managedRoots = resolveAdapterManagedRoots(adapter, input);
  for (const legacyStatePath of adapter.resolveLegacyInstallStatePaths(input)) {
    if (!fs.existsSync(legacyStatePath)) continue;
    const legacyRoot = managedRoots.find(root => isInsideRoot(legacyStatePath, root)) || currentRoot;
    return { targetRoot: legacyRoot, installStatePath: legacyStatePath, exists: true };
  }
  return { targetRoot: currentRoot, installStatePath: currentStatePath, exists: false };
}

function buildDiscoveryRecord(adapter, context) {
  const installTargetInput = {
    homeDir: context.homeDir,
    projectRoot: context.projectRoot,
    repoRoot: context.projectRoot,
  };
  const { targetRoot, installStatePath, exists } = locateInstallState(adapter, installTargetInput);

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

// Discovery enumerates ADAPTERS, not target ids: five targets ship
// home+project adapter pairs under one target id, and resolving those ids
// through getInstallTargetAdapter() always lands on the first (home)
// adapter -- which both duplicated the home record and left project
// installs of those targets invisible to doctor, repair, and uninstall.
function resolveDiscoveryAdapters(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return listInstallTargetAdapters();
  }

  const adapters = [];
  for (const target of normalizeTargets(targets)) {
    // normalizeTargets() already rejected unknown and retired ids with their
    // dedicated errors, so every canonical target here answers to at least
    // one adapter. Take every adapter that answers, not just the first: an
    // explicit --target kiro must cover kiro-home AND kiro-project, the
    // same pair the no-argument default examines.
    for (const adapter of listInstallTargetAdapters().filter(candidate => candidate.supports(target))) {
      if (!adapters.includes(adapter)) {
        adapters.push(adapter);
      }
    }
  }
  return adapters;
}

function discoverInstalledStates(options = {}) {
  const context = {
    homeDir: options.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir(),
    projectRoot: options.projectRoot || process.cwd(),
  };

  return resolveDiscoveryAdapters(options.targets).map(adapter => buildDiscoveryRecord(adapter, context));
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

// A profile that resolved to no module at all left the tool with the engine
// only, whatever the profile promised. Doctor used to call that healthy.
function checkProfileSelection(state, record) {
  const profile = state.request ? state.request.profile : null;
  const selectedModules = state.resolution && Array.isArray(state.resolution.selectedModules)
    ? state.resolution.selectedModules
    : [];
  if (!profile || selectedModules.length > 0) {
    return [];
  }

  const target = record.adapter.target;
  return [buildIssue(
    'warning',
    'profile-selected-nothing',
    `Profile ${profile} selected no module for ${target}, so the tool has the engine only. Run egc install --target ${shellQuote(target)} --profile ${shellQuote(profile)} with this version to install what the profile names`,
    {
      profile,
      skippedModules: state.resolution && Array.isArray(state.resolution.skippedModules)
        ? [...state.resolution.skippedModules]
        : [],
    }
  )];
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

  const driftedFiles = operationHealth.drifted.filter(entry => entry.operation?.kind !== HOOK_OPERATION_KIND);
  if (driftedFiles.length > 0) {
    issues.push(buildIssue(
      'warning',
      'drifted-managed-files',
      `${driftedFiles.length} managed file(s) differ from the source repo`,
      {
        paths: driftedFiles.map(entry => entry.destinationPath),
      }
    ));
  }

  // A hook entry EGC wrote into a tool's config and that is no longer there is
  // not drift of a file but a tool that silently lost its hook: an error, named
  // by event and config, so the regression is seen the first time doctor runs.
  if (operationHealth.missingHooks.length > 0) {
    const count = operationHealth.missingHooks.length;
    issues.push(buildIssue(
      'error',
      'missing-hook-entries',
      `${count} hook entr${count === 1 ? 'y' : 'ies'} EGC installed ${count === 1 ? 'is' : 'are'} absent from the config the tool reads (run 'egc repair' to put ${count === 1 ? 'it' : 'them'} back)`,
      {
        paths: operationHealth.missingHooks.map(entry => `${entry.operation.hookEvent || 'hook'} in ${entry.destinationPath}`),
      }
    ));
  }

  if (operationHealth.missingSource.length > 0) {
    issues.push(buildIssue(
      'error',
      'missing-source-files',
      `${operationHealth.missingSource.length} source file(s) referenced by install-state are missing (run 'egc repair' to prune orphaned entries)`,
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
    ...checkProfileSelection(state, record),
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

// The manifests, or the reason they are refused (a path that is unsafe or
// leaves the repository through a link): a refused manifest is reported per
// record instead of aborting the whole run, and nothing is written from it.
function manifestsOrError(repoRoot) {
  try {
    return { manifests: loadInstallManifests({ repoRoot }), error: null };
  } catch (error) {
    return { manifests: null, error: error.message };
  }
}

// The roots a lifecycle command works in, as the caller gave them or as
// the environment has them.
function lifecycleRoots(options) {
  return {
    repoRoot: options.repoRoot || DEFAULT_REPO_ROOT,
    homeDir: options.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir(),
    projectRoot: options.projectRoot || process.cwd(),
  };
}

// The same roots with the manifests read from the repository (or the reason
// they were refused) and the versions a report carries.
function manifestContext(options) {
  const roots = lifecycleRoots(options);
  const loaded = manifestsOrError(roots.repoRoot);
  const manifests = loaded.manifests || { modulesVersion: null };
  return {
    loaded,
    context: { ...roots, manifestVersion: manifests.modulesVersion, packageVersion: readPackageVersion(roots.repoRoot) },
  };
}

// The install-states that exist for the targets asked about.
function existingInstallStates(homeDir, projectRoot, targets) {
  return discoverInstalledStates({ homeDir, projectRoot, targets }).filter(record => record.exists);
}

function buildDoctorReport(options = {}) {
  const { loaded, context } = manifestContext(options);
  const records = existingInstallStates(options.homeDir, options.projectRoot, options.targets)
    .map(record => (loaded.error ? { ...record, error: `Install manifests refused: ${loaded.error}` } : record));
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
    // A refused manifest with no record to carry it is still an error.
    errorCount: loaded.error && records.length === 0 ? 1 : 0,
    warningCount: 0,
  });

  return {
    generatedAt: new Date().toISOString(),
    packageVersion: context.packageVersion,
    manifestVersion: context.manifestVersion,
    manifestError: loaded.error,
    results,
    summary,
  };
}

module.exports = {
  buildDoctorReport,
  discoverInstalledStates,
  manifestContext,
  existingInstallStates,
  lifecycleRoots,
};
