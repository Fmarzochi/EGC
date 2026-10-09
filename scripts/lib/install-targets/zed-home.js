const os = require('node:os');
const path = require('node:path');

const {
  createInstallTargetAdapter,
  isForeignPlatformPath,
  planFlatSkillOperation,
  resolveModulesPlan,
} = require('./helpers');

function resolveSharedAgentsRoot(input) {
  const home = typeof input === 'string' ? input : input?.homeDir;
  return path.join(home || os.homedir(), '.agents');
}

module.exports = createInstallTargetAdapter({
  id: 'zed-home',
  target: 'zed',
  kind: 'home',
  rootSegments: ['.config', 'zed'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.zed',
  resolveManagedRoots(input, adapter) {
    return [adapter.resolveRoot(input), resolveSharedAgentsRoot(input)];
  },
  planOperations(input, adapter) {
    const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
    const skillsDir = path.join(resolveSharedAgentsRoot(planningInput), 'skills');
    return modules.flatMap(module => (Array.isArray(module.paths) ? module.paths : [])
      .filter(sourceRelativePath => !isForeignPlatformPath(sourceRelativePath, adapter.target))
      .map(sourceRelativePath => planFlatSkillOperation(adapter, module.id, sourceRelativePath, planningInput, targetRoot, skillsDir)));
  },
});
