const fs = require('node:fs');
const path = require('node:path');
const {
  buildValidationIssue,
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
  createManagedOperation,
  createRemappedOperation,
  resolveBaseRoot,
} = require('./helpers');
const { assertSafeMcpConfig } = require('../mcp-config');
const {
  createWindsurfGateGuardOperations,
} = require('../windsurf-gateguard-operations');
const { devinConfigIssues, resolveDevinProjectConfigPath } = require('../devin-local-hooks');

const DEVIN_WORKSPACE_DIR = '.devin';
const WINDSURF_WORKSPACE_DIR = '.windsurf';
const INSTALL_STATE_FILE = 'egc-install-state.json';
const DEVIN_MCP_CONFIG_FILE = 'mcp_config.local.json';
const DEVIN_MCP_MODULE_ID = 'egc-mcp-servers';
const EGC_MCP_SERVERS = ['egc-guardian', 'egc-memory'];

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// The Devin Desktop docs say .devin/skills/ is loaded when it exists and
// .windsurf/skills/ only when it does not, never merged
// (docs.devin.ai/desktop/cascade/skills); the Devin CLI 3000.11.3 lists both
// (`devin skills list`). Rules from .devin/rules/ and .windsurf/rules/ load
// in both (`devin rules list`). The root below is right under either skills
// behavior, since it neither hides a folder nor splits the skills across
// two: .devin/ once .devin/skills/ exists; .windsurf/ while the project has
// it and no .devin/skills/; .devin/ on a project that has neither.
function resolveWorkspaceDir(projectRoot) {
  if (isDirectory(path.join(projectRoot, DEVIN_WORKSPACE_DIR, 'skills'))) return DEVIN_WORKSPACE_DIR;
  if (isDirectory(path.join(projectRoot, WINDSURF_WORKSPACE_DIR))) return WINDSURF_WORKSPACE_DIR;
  return DEVIN_WORKSPACE_DIR;
}

// Devin Local, the agent in Devin Desktop and the Devin CLI, reads the MCP
// servers of a project from .devin/mcp_config.local.json, the gitignored local
// file (docs.devin.ai/cli/extensibility/mcp, read on 2026-10-11), so the
// absolute paths of this machine's servers stay out of the committed config.
// The user-level mcp_config.json the docs also describe belongs to Cascade,
// the agent Devin Desktop removed on 2026-09-08, and is left alone.
function resolveDevinMcpConfigPath(projectRoot) {
  return path.join(projectRoot, DEVIN_WORKSPACE_DIR, DEVIN_MCP_CONFIG_FILE);
}

function devinMcpServersPayload(repoRoot) {
  const servers = EGC_MCP_SERVERS.map(name => [name, {
    command: 'node',
    args: [path.join(repoRoot, 'mcp', 'servers', name, 'build', 'index.js')],
    env: {},
  }]);
  return { mcpServers: Object.fromEntries(servers) };
}

function createDevinMcpOperation(repoRoot, projectRoot) {
  const mergePayload = devinMcpServersPayload(repoRoot);
  assertSafeMcpConfig(mergePayload, 'the EGC MCP servers for Devin Local');
  return createManagedOperation({
    kind: 'merge-json',
    moduleId: DEVIN_MCP_MODULE_ID,
    sourceRelativePath: '.mcp.json',
    destinationPath: resolveDevinMcpConfigPath(projectRoot),
    strategy: 'merge-json',
    ownership: 'managed',
    scaffoldOnly: false,
    mergePayload,
  });
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

    // Devin Local reads project hooks and MCP servers only under .devin/,
    // whichever directory holds the skills, so both configs go there even
    // while the scripts stay under .windsurf/.
    const projectRoot = resolveBaseRoot('project', planningInput);
    return [
      ...createFlatSkillPlanOperations(input, adapter),
      ...createWindsurfGateGuardOperations(
        adapter,
        targetRoot,
        createRemappedOperation,
        resolveDevinProjectConfigPath(projectRoot)
      ),
      createDevinMcpOperation(input.repoRoot, projectRoot),
    ];
  },
});
