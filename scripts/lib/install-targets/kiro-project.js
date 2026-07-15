const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'kiro-project',
  target: 'kiro',
  kind: 'project',
  rootSegments: ['.kiro'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.kiro',
  planOperations: createFlatSkillPlanOperations,
});
