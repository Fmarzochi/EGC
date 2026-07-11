const {
  createInstallTargetAdapter,
  planFlatSkillOperation,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'codex-home',
  target: 'codex',
  kind: 'home',
  rootSegments: ['.agents'],
  installStatePathSegments: ['egc', 'codex-install-state.json'],
  nativeRootRelativePath: '.agents',
  planOperations(input, adapter) {
    const modules = Array.isArray(input.modules)
      ? input.modules
      : (input.module ? [input.module] : []);
    const planningInput = {
      repoRoot: input.repoRoot,
      projectRoot: input.projectRoot,
      homeDir: input.homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

    return modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths.map(sourceRelativePath => planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot));
    });
  },
});
