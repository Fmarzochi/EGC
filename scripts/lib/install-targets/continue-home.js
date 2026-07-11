const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'continue-home',
  target: 'continue',
  kind: 'home',
  rootSegments: ['.continue'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.continue',
  planOperations: createFlatSkillPlanOperations,
});
