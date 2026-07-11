const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'amp-home',
  target: 'amp',
  kind: 'home',
  rootSegments: ['.amp'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.amp',
  planOperations: createFlatSkillPlanOperations,
});
