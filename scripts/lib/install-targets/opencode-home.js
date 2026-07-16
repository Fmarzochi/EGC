const path = require('node:path');

const {
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'opencode-home',
  target: 'opencode',
  kind: 'home',
  rootSegments: ['.config', 'opencode'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.opencode',
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
      const paths = (Array.isArray(module.paths) ? module.paths : [])
        .filter(p => !isForeignPlatformPath(p, adapter.target));
      return paths.flatMap(sourceRelativePath => {
        const normalizedPath = normalizeRelativePath(sourceRelativePath);

        // OpenCode discovers skills at ~/.config/opencode/skills/<name>/ (flat).
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
