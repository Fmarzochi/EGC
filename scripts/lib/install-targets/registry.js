const amazonqProject = require('./amazonq-project');
const antigravityProject = require('./antigravity-project');
const claudeCodeHome = require('./claude-home');
const egcHome = require('./gemini-home');
const codebuddyProject = require('./codebuddy-project');
const codexHome = require('./codex-home');
const cursorProject = require('./cursor-project');
const geminiProject = require('./gemini-project');
const gooseHome = require('./goose-home');
const kiroHome = require('./kiro-home');
const openhandsHome = require('./openhands-home');
const kiroProject = require('./kiro-project');
const opencodeHome = require('./opencode-home');
const windsurfHome = require('./windsurf-home');
const windsurfProject = require('./windsurf-project');
const ampHome = require('./amp-home');
const ampProject = require('./amp-project');
const copilotHome = require('./copilot-home');
const zedHome = require('./zed-home');
const continueHome = require('./continue-home');
const continueProject = require('./continue-project');
const traeProject = require('./trae-project');

const ADAPTERS = Object.freeze([
  egcHome,
  claudeCodeHome,
  cursorProject,
  antigravityProject,
  amazonqProject,
  codexHome,
  gooseHome,
  openhandsHome,
  geminiProject,
  opencodeHome,
  codebuddyProject,
  kiroHome,
  kiroProject,
  windsurfHome,
  windsurfProject,
  ampHome,
  ampProject,
  copilotHome,
  zedHome,
  continueHome,
  continueProject,
  traeProject,
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
