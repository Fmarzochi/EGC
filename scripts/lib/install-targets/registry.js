const aiderProject = require('./aider-project');
const amazonqProject = require('./amazonq-project');
const amazonqHome = require('./amazonq-home');
const antigravityProject = require('./antigravity-project');
const claudeCodeHome = require('./claude-home');
const egcHome = require('./gemini-home');
const codebuddyProject = require('./codebuddy-project');
const clineProject = require('./cline-project');
const codexHome = require('./codex-home');
const cursorProject = require('./cursor-project');
const gooseHome = require('./goose-home');
const kiroHome = require('./kiro-home');
const openhandsHome = require('./openhands-home');
const openhandsProject = require('./openhands-project');
const qwenProject = require('./qwen-project');
const kiroProject = require('./kiro-project');
const opencodeHome = require('./opencode-home');
const windsurfHome = require('./windsurf-home');
const windsurfProject = require('./windsurf-project');
const ampHome = require('./amp-home');
const ampProject = require('./amp-project');
const copilotHome = require('./copilot-home');
const zedHome = require('./zed-home');
const traeProject = require('./trae-project');
const junieHome = require('./junie-home');
const junieProject = require('./junie-project');
const warpProject = require('./warp-project');

// Retired adapters (files kept for history and trivial rollback, never
// registered): gemini-project (standalone Gemini CLI stopped serving
// 2026-06-18; its successor Antigravity reads the shared ~/.gemini home,
// which egc-home still owns), continue-home/continue-project (Continue.dev
// shut down after the Cursor acqui-hire, repo read-only since 2026-06),
// roocode-project (project archived upstream since 2026-05-15).
const ADAPTERS = Object.freeze([
  egcHome,
  claudeCodeHome,
  cursorProject,
  antigravityProject,
  amazonqProject,
  amazonqHome,
  aiderProject,
  codexHome,
  gooseHome,
  openhandsHome,
  openhandsProject,
  qwenProject,
  opencodeHome,
  codebuddyProject,
  clineProject,
  kiroHome,
  kiroProject,
  windsurfHome,
  windsurfProject,
  ampHome,
  ampProject,
  copilotHome,
  zedHome,
  traeProject,
  junieHome,
  junieProject,
  warpProject,
]);

function listInstallTargetAdapters() {
  return ADAPTERS.slice();
}

function getInstallTargetAdapter(targetOrAdapterId) {
  const adapter = ADAPTERS.find(candidate => candidate.supports(targetOrAdapterId));

  if (!adapter) {
    throw new Error(`Unknown install target adapter: ${targetOrAdapterId}`);
  }

  return adapter;
}

function planInstallTargetScaffold(options = {}) {
  const adapter = getInstallTargetAdapter(options.target);
  const modules = Array.isArray(options.modules) ? options.modules : [];
  const planningInput = {
    repoRoot: options.repoRoot,
    projectRoot: options.projectRoot || options.repoRoot,
    homeDir: options.homeDir,
  };
  const validationIssues = adapter.validate(planningInput);
  const blockingIssues = validationIssues.filter(issue => issue.severity === 'error');
  if (blockingIssues.length > 0) {
    throw new Error(blockingIssues.map(issue => issue.message).join('; '));
  }
  const targetRoot = adapter.resolveRoot(planningInput);
  const installStatePath = adapter.getInstallStatePath(planningInput);
  const operations = adapter.planOperations({
    ...planningInput,
    modules,
  });

  return {
    adapter: {
      id: adapter.id,
      target: adapter.target,
      kind: adapter.kind,
    },
    targetRoot,
    installStatePath,
    validationIssues,
    operations,
  };
}

module.exports = {
  getInstallTargetAdapter,
  listInstallTargetAdapters,
  planInstallTargetScaffold,
};
