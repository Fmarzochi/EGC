'use strict';

const RESOLUTION_DRIFT_ISSUE_CODE = 'resolution-drift';

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
    if (!request || !target || request.legacyMode) {
      continue;
    }

    const issues = Array.isArray(result.issues) ? result.issues : [];
    if (!issues.some(issue => issue.code === RESOLUTION_DRIFT_ISSUE_CODE)) {
      continue;
    }

    const args = ['--target', target];
    if (request.profile) {
      args.push('--profile', request.profile);
    } else if (Array.isArray(request.modules) && request.modules.length > 0) {
      args.push('--modules', request.modules.join(','));
    } else {
      continue;
    }

    for (const componentId of request.includeComponents || []) {
      args.push('--with', componentId);
    }
    for (const componentId of request.excludeComponents || []) {
      args.push('--without', componentId);
    }

    plans.push({
      adapterId: result.adapter.id,
      target,
      args,
    });
  }

  return plans;
}

module.exports = {
  planDriftReinstalls,
};
