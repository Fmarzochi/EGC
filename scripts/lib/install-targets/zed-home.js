const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'zed-home',
  target: 'zed',
  kind: 'home',
  rootSegments: ['.config', 'zed'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.zed',
  planOperations: createFlatSkillPlanOperations,
});
