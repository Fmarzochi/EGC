const os = require('node:os');
const path = require('node:path');

const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
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
    return createFlatSkillPlanOperations(input, adapter, {
      skillsDir: planningInput => path.join(resolveSharedAgentsRoot(planningInput), 'skills'),
    });
  },
});
