const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

// Qwen Code discovers project skills from
// .qwen/skills/<skill-name>/SKILL.md.
module.exports = createInstallTargetAdapter({
  id: 'qwen-project',
  target: 'qwen',
  kind: 'project',
  rootSegments: ['.qwen'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.qwen',
  planOperations: createFlatSkillPlanOperations,
});
