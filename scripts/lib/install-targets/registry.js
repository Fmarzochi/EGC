const antigravityProject = require('./antigravity-project');
const claudeHome = require('./claude-home');
const codexHome = require('./codex-home');
const cursorProject = require('./cursor-project');
const opencodeHome = require('./opencode-home');

const ADAPTERS = Object.freeze([
  claudeHome,
  cursorProject,
  antigravityProject,
  codexHome,
  opencodeHome,
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
  const targetRoot = adapter.resolveRoot(planningInput);
  const installStatePath = adapter.getInstallStatePath(planningInput);
  const operations = modules.flatMap(module => {
    const paths = Array.isArray(module.paths) ? module.paths : [];
    return paths.map(sourceRelativePath => adapter.createScaffoldOperation(
      module.id,
      sourceRelativePath,
      planningInput
    ));
  });

  return {
    adapter: {
      id: adapter.id,
      target: adapter.target,
      kind: adapter.kind,
    },
    targetRoot,
    installStatePath,
    operations,
  };
}

module.exports = {
  getInstallTargetAdapter,
  listInstallTargetAdapters,
  planInstallTargetScaffold,
};
