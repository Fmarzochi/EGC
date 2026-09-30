const fs = require('node:fs');
const path = require('node:path');
const {
  buildValidationIssue,
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
  resolveBaseRoot,
} = require('./helpers');
const {
  createWindsurfGateGuardOperations,
} = require('../windsurf-gateguard-operations');
const { devinConfigIssues, resolveDevinProjectConfigPath } = require('../devin-local-hooks');

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

// Devin Desktop loads .devin/skills/ when it exists and only falls back to
// .windsurf/skills/ when it does not; the two are never merged
// (docs.devin.ai/desktop/cascade/skills). Rules are different: .devin/rules/
// and .windsurf/rules/ both load (docs.devin.ai/cli/extensibility/rules).
// The skills rule decides the root: .devin/ once .devin/skills/ exists;
// .windsurf/ while the project has it and no .devin/skills/ (creating
// .devin/skills/ beside it would hide every skill the person keeps in
// .windsurf/skills/); .devin/ on a project that has neither.
function resolveWorkspaceDir(projectRoot) {
  if (isDirectory(path.join(projectRoot, DEVIN_WORKSPACE_DIR, 'skills'))) return DEVIN_WORKSPACE_DIR;
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
  validateMore(input) {
    if (!input.projectRoot && !input.repoRoot) return [];
    return devinConfigIssues(resolveDevinProjectConfigPath(resolveBaseRoot('project', input)), buildValidationIssue);
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

    // Devin Local reads project hooks only under .devin/, whichever
    // directory holds the skills, so the config goes there even while the
    // scripts stay under .windsurf/.
    return [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createWindsurfGateGuardOperations(
        adapter,
        targetRoot,
        createRemappedOperation,
        resolveDevinProjectConfigPath(resolveBaseRoot('project', planningInput))
      ),
    ];
  },
});
