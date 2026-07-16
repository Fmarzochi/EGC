'use strict';

const RESOLUTION_DRIFT_ISSUE_CODE = 'resolution-drift';

function hasDriftIssue(result) {
  const issues = Array.isArray(result.issues) ? result.issues : [];
  return issues.some(issue => issue.code === RESOLUTION_DRIFT_ISSUE_CODE);
}

function buildModuleArgs(request) {
  if (request.profile) return ['--profile', request.profile];
  if (Array.isArray(request.modules) && request.modules.length > 0) {
    return ['--modules', request.modules.join(',')];
  }
  return null;
}

function buildComponentFlags(request) {
  const flags = [];
  for (const componentId of request.includeComponents || []) {
    flags.push('--with', componentId);
  }
  for (const componentId of request.excludeComponents || []) {
    flags.push('--without', componentId);
  }
  return flags;
}

/**
 * Builds install-apply argv for every doctor result whose issues include
 * resolution drift. Recorded-content repair restores files but never
 * rewrites the recorded module resolution, so these targets need a fresh
 * manifest apply built from the install request stored in install-state.
 */
function planDriftReinstalls(report) {
  const results = Array.isArray(report?.results) ? report.results : [];
  const plans = [];

  for (const result of results) {
    const request = result?.state?.request;
    const target = result?.adapter?.target;
    if (!request || !target || request.legacyMode) continue;
    if (!hasDriftIssue(result)) continue;

    const moduleArgs = buildModuleArgs(request);
    if (!moduleArgs) continue;

    const args = ['--target', target, ...moduleArgs, ...buildComponentFlags(request)];
    plans.push({ adapterId: result.adapter.id, target, args });
  }

  return plans;
}

module.exports = {
  planDriftReinstalls,
};
