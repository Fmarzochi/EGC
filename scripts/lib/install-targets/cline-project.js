const {
  createFlatRuleOperations,
  createInstallTargetAdapter,
  isForeignPlatformPath,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'cline-project',
  target: 'cline',
  kind: 'project',
  rootSegments: ['.clinerules'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.clinerules',
  planOperations(input, adapter) {
    let modules;
    if (Array.isArray(input.modules)) {
      modules = input.modules;
    } else if (input.module) {
      modules = [input.module];
    } else {
      modules = [];
    }

    const {
      repoRoot,
      projectRoot,
      homeDir,
    } = input;

    const planningInput = {
      repoRoot,
      projectRoot,
      homeDir,
    };

    const targetRoot = adapter.resolveRoot(planningInput);

    return modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];

      return paths
        .filter(sourcePath => !isForeignPlatformPath(sourcePath, adapter.target))
        .flatMap(sourceRelativePath => {
          if (sourceRelativePath === 'rules') {
            return createFlatRuleOperations({
              moduleId: module.id,
              repoRoot,
              sourceRelativePath,
              destinationDir: targetRoot,
            });
          }

          return [
            adapter.createScaffoldOperation(
              module.id,
              sourceRelativePath,
              planningInput
            ),
          ];
        });
    });
  },
});
