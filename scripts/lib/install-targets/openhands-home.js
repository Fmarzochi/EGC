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
// GateGuard hook wiring: OpenHands has no documented hook API equivalent to
// ~/.codex/hooks.json.
module.exports = createInstallTargetAdapter({
  id: 'openhands-home',
  target: 'openhands',
  kind: 'home',
  rootSegments: ['.agents'],
  installStatePathSegments: ['egc', 'openhands-install-state.json'],
  nativeRootRelativePath: '.agents',
  planOperations: createFlatSkillPlanOperations,
});
