const os = require('os');
const path = require('path');

function normalizeRelativePath(relativePath) {
  return String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

function resolveBaseRoot(scope, input = {}) {
  if (scope === 'home') {
    return input.homeDir || os.homedir();
  }

  if (scope === 'project') {
    const projectRoot = input.projectRoot || input.repoRoot;
    if (!projectRoot) {
      throw new Error('projectRoot or repoRoot is required for project install targets');
    }
    return projectRoot;
  }

  throw new Error(`Unsupported install target scope: ${scope}`);
}

function createInstallTargetAdapter(config) {
  const adapter = {
    id: config.id,
    target: config.target,
    kind: config.kind,
    nativeRootRelativePath: config.nativeRootRelativePath || null,
    supports(target) {
      return target === config.target || target === config.id;
    },
    resolveRoot(input = {}) {
      const baseRoot = resolveBaseRoot(config.kind, input);
      return path.join(baseRoot, ...config.rootSegments);
    },
    getInstallStatePath(input = {}) {
      const root = adapter.resolveRoot(input);
      return path.join(root, ...config.installStatePathSegments);
    },
    resolveDestinationPath(sourceRelativePath, input = {}) {
      const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
      const targetRoot = adapter.resolveRoot(input);

      if (
        config.nativeRootRelativePath
        && normalizedSourcePath === normalizeRelativePath(config.nativeRootRelativePath)
      ) {
        return targetRoot;
      }

      return path.join(targetRoot, normalizedSourcePath);
    },
    determineStrategy(sourceRelativePath) {
      const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);

      if (
        config.nativeRootRelativePath
        && normalizedSourcePath === normalizeRelativePath(config.nativeRootRelativePath)
      ) {
        return 'sync-root-children';
      }

      return 'preserve-relative-path';
    },
    createScaffoldOperation(moduleId, sourceRelativePath, input = {}) {
      const normalizedSourcePath = normalizeRelativePath(sourceRelativePath);
      return {
        kind: 'copy-path',
        moduleId,
        sourceRelativePath: normalizedSourcePath,
        destinationPath: adapter.resolveDestinationPath(normalizedSourcePath, input),
        strategy: adapter.determineStrategy(normalizedSourcePath),
        ownership: 'managed',
        scaffoldOnly: true,
      };
    },
  };

  return Object.freeze(adapter);
}

module.exports = {
  createInstallTargetAdapter,
  normalizeRelativePath,
};
