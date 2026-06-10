const path = require('path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'amp-project',
  target: 'amp',
  kind: 'project',
  rootSegments: ['.amp'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.amp',
  planOperations(input, adapter) {
    const modules = Array.isArray(input.modules)
      ? input.modules
      : (input.module ? [input.module] : []);
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
        .filter(p => !isForeignPlatformPath(p, adapter.target))
        .flatMap(sourceRelativePath => {
          const normalizedPath = normalizeRelativePath(sourceRelativePath);

          // Amp discovers skills at .amp/skills/<name>/ (flat).
          // Strip the leading category segment to match the expected structure.
          if (normalizedPath.startsWith('skills/')) {
            const parts = normalizedPath.slice('skills/'.length).split('/');
            const flatRemainder = parts.length >= 2 ? parts.slice(1).join('/') : parts.join('/');
            return [
              createRemappedOperation(
                adapter,
                module.id,
                sourceRelativePath,
                path.join(targetRoot, 'skills', flatRemainder),
                { strategy: 'preserve-relative-path' }
              ),
            ];
          }

          return [adapter.createScaffoldOperation(module.id, sourceRelativePath, planningInput)];
        });
    });
  },
});
