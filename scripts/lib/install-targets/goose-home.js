const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

// Goose already reads skills from ~/.agents/skills/<name>/ -- the same
// shared directory codex-home.js writes to. This adapter exists purely for
// discoverability (`--target goose` instead of requiring `--target codex`),
// so it deliberately skips codex-home's GateGuard hook wiring: Goose has no
// documented hook API equivalent to ~/.codex/hooks.json.
module.exports = createInstallTargetAdapter({
  id: 'goose-home',
  target: 'goose',
  kind: 'home',
  rootSegments: ['.agents'],
  installStatePathSegments: ['egc', 'goose-install-state.json'],
  nativeRootRelativePath: '.agents',
  planOperations: createFlatSkillPlanOperations,
});
