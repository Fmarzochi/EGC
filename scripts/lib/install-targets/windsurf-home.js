const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'windsurf-home',
  target: 'windsurf',
  kind: 'home',
  rootSegments: ['.codeium', 'windsurf'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.codeium/windsurf',
  planOperations: createFlatSkillPlanOperations,
});
