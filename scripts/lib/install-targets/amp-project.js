const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'amp-project',
  target: 'amp',
  kind: 'project',
  rootSegments: ['.amp'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.amp',
  planOperations: createFlatSkillPlanOperations,
});
