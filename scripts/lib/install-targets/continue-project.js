const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'continue-project',
  target: 'continue',
  kind: 'project',
  rootSegments: ['.continue'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.continue',
  planOperations: createFlatSkillPlanOperations,
});
