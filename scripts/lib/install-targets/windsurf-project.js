const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'windsurf-project',
  target: 'windsurf',
  kind: 'project',
  rootSegments: ['.windsurf'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.windsurf',
  planOperations: createFlatSkillPlanOperations,
});
