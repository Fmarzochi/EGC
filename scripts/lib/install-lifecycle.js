// The implementation lives in install-lifecycle-core.js,
// install-lifecycle-operations.js, install-lifecycle-inspect.js,
// install-lifecycle-doctor.js, install-lifecycle-repair.js and
// install-lifecycle-uninstall.js; this file keeps the original public surface
// so every importer is unchanged.

const { DEFAULT_REPO_ROOT, normalizeTargets } = require('./install-lifecycle-core');
const { buildDoctorReport, discoverInstalledStates } = require('./install-lifecycle-doctor');
const { repairInstalledStates } = require('./install-lifecycle-repair');
const { uninstallInstalledStates } = require('./install-lifecycle-uninstall');

module.exports = {
  DEFAULT_REPO_ROOT,
  buildDoctorReport,
  discoverInstalledStates,
  normalizeTargets,
  repairInstalledStates,
  uninstallInstalledStates,
};
