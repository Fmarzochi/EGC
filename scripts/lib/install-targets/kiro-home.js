const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'kiro-home',
  target: 'kiro',
  kind: 'home',
  rootSegments: ['.kiro'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.kiro',
  planOperations: createFlatSkillPlanOperations,
});
