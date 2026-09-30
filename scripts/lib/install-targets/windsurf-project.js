const fs = require('node:fs');
const path = require('node:path');
const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
  resolveBaseRoot,
} = require('./helpers');
const {
  createWindsurfGateGuardOperations,
} = require('../windsurf-gateguard-operations');

const DEVIN_WORKSPACE_DIR = '.devin';
const WINDSURF_WORKSPACE_DIR = '.windsurf';
const INSTALL_STATE_FILE = 'egc-install-state.json';

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// Devin Desktop reads .devin/ and, once it exists, ignores .windsurf/ (the
// two are never merged); .windsurf/ is read only while .devin/ is absent.
// Writing where Devin reads therefore means .devin/ when it is there,
// .windsurf/ while it is the only one there (creating .devin/ beside it
// would hide everything the person keeps in .windsurf/), and .devin/ on a
// project that has neither.
function resolveWorkspaceDir(projectRoot) {
  if (isDirectory(path.join(projectRoot, DEVIN_WORKSPACE_DIR))) return DEVIN_WORKSPACE_DIR;
  if (isDirectory(path.join(projectRoot, WINDSURF_WORKSPACE_DIR))) return WINDSURF_WORKSPACE_DIR;
  return DEVIN_WORKSPACE_DIR;
}

module.exports = createInstallTargetAdapter({
  id: 'windsurf-project',
  target: 'windsurf',
  kind: 'project',
  rootSegments: [DEVIN_WORKSPACE_DIR],
  installStatePathSegments: [INSTALL_STATE_FILE],
  nativeRootRelativePath: DEVIN_WORKSPACE_DIR,
  resolveRoot(input) {
    const projectRoot = resolveBaseRoot('project', input);
    return path.join(projectRoot, resolveWorkspaceDir(projectRoot));
  },
  // Retirement and uninstall may clean both directories: an install
  // recorded under .windsurf/ before the workspace moved to .devin/ is
  // still EGC's to remove.
  resolveManagedRoots(input) {
    const projectRoot = resolveBaseRoot('project', input);
    return [path.join(projectRoot, DEVIN_WORKSPACE_DIR), path.join(projectRoot, WINDSURF_WORKSPACE_DIR)];
  },
  resolveLegacyInstallStatePaths(input, adapter) {
    const projectRoot = resolveBaseRoot('project', input);
    const legacyStatePath = path.join(projectRoot, WINDSURF_WORKSPACE_DIR, INSTALL_STATE_FILE);
    if (legacyStatePath === adapter.getInstallStatePath(input) || !fs.existsSync(legacyStatePath)) return [];
    return [legacyStatePath];
  },
  planOperations(input, adapter) {
    const planningInput = {
      repoRoot: input.repoRoot,
      projectRoot: input.projectRoot,
      homeDir: input.homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

    return [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createWindsurfGateGuardOperations(adapter, targetRoot, createRemappedOperation),
    ];
  },
});
