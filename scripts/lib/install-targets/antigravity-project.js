const path = require('path');

const {
  createFlatRuleOperations,
  createInstallTargetAdapter,
  createManagedScaffoldOperation,
  createRemappedOperation,
  normalizeRelativePath,
} = require('./helpers');

const SUPPORTED_SOURCE_PREFIXES = ['rules', 'commands', 'agents', 'skills', '.agents', 'AGENTS.md'];

function supportsAntigravitySourcePath(sourceRelativePath) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);
  return SUPPORTED_SOURCE_PREFIXES.some(prefix => (
    normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  ));
}

module.exports = createInstallTargetAdapter({
  id: 'antigravity-project',
  target: 'antigravity',
  kind: 'project',
  rootSegments: ['.agents'],
  installStatePathSegments: ['egc-install-state.json'],
  supportsModule(module) {
    const paths = Array.isArray(module && module.paths) ? module.paths : [];
    return paths.length > 0;
  },
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
        .filter(supportsAntigravitySourcePath)
        .flatMap(sourceRelativePath => {
          const normalizedPath = normalizeRelativePath(sourceRelativePath);

          if (sourceRelativePath === 'rules') {
            return createFlatRuleOperations({
              moduleId: module.id,
              repoRoot,
              sourceRelativePath,
              destinationDir: path.join(targetRoot, 'rules'),
            });
          }

          if (sourceRelativePath === 'commands') {
            return [
              createManagedScaffoldOperation(
                module.id,
                sourceRelativePath,
                path.join(targetRoot, 'workflows'),
                'preserve-relative-path'
              ),
            ];
          }

          if (sourceRelativePath === 'agents') {
            return [
              createManagedScaffoldOperation(
                module.id,
                sourceRelativePath,
                path.join(targetRoot, 'skills'),
                'preserve-relative-path'
              ),
            ];
          }

          // AGY discovers project skills at .agent/skills/<name>/ (flat).
          // Strip the leading category segment so repo layout does not leak
          // into the discovery path.
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
