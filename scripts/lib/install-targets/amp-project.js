const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

// GateGuard fact-forcing gate is intentionally NOT wired for Amp. See the
// matching comment in amp-home.js for the full evidence trail: Amp's hooks
// documentation (https://ampcode.com/manual?internal#hooks) is gated to
// Sourcegraph-internal sessions and the only publicly confirmed action types
// are declarative (send-user-message, redact-tool-input), not a documented
// external-script invocation gateguard-fact-force.js could hook into.

module.exports = createInstallTargetAdapter({
  id: 'amp-project',
  target: 'amp',
  kind: 'project',
  rootSegments: ['.amp'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.amp',
  planOperations: createFlatSkillPlanOperations,
});
