const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

module.exports = createInstallTargetAdapter({
  id: 'copilot-home',
  target: 'copilot',
  kind: 'home',
  rootSegments: ['.github'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.github',
  planOperations: createFlatSkillPlanOperations,
});
