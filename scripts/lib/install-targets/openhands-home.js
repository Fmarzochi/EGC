const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

// OpenHands' recommended AgentSkills format is .agents/skills/<name>/SKILL.md
// -- the same shared directory codex-home.js and goose-home.js already write
// to (confirmed against current OpenHands docs: legacy .openhands/microagents/
// still works but .agents/skills/ is the documented, recommended path as of
// 2026). This adapter exists purely for discoverability (`--target openhands`
// instead of requiring `--target codex`), same shape as goose-home.js. No
// hook wiring here: the Guardian goes into the project's .openhands/hooks.json
// through openhands-project.js. OpenHands also reads a global
// ~/.openhands/hooks.json when the project has none, which EGC does not write
// yet (see docs/spec/integration-tiers.md).
module.exports = createInstallTargetAdapter({
  id: 'openhands-home',
  target: 'openhands',
  kind: 'home',
  rootSegments: ['.agents'],
  installStatePathSegments: ['egc', 'openhands-install-state.json'],
  nativeRootRelativePath: '.agents',
  planOperations: createFlatSkillPlanOperations,
});
