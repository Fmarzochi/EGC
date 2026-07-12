const {
  createFlatSkillPlanOperations,
  createInstallTargetAdapter,
} = require('./helpers');

// GateGuard fact-forcing gate is intentionally NOT wired for Amp.
//
// Amp (Sourcegraph) does have a hooks system (see
// https://ampcode.com/news/hooks, "tool:pre-execute" event with a
// `compatibilityDate` field, matching against tool names, and actions such
// as `send-user-message` that can cancel a tool call). But as of this
// investigation (July 2026):
//   - The full schema lives behind https://ampcode.com/manual?internal#hooks,
//     which resolves to an empty section for non-Sourcegraph-internal
//     sessions (confirmed via direct HTTP fetch: the page's own embedded
//     state reports `userIsInternal: false` and renders no hooks content).
//   - The public /news/hooks announcement itself carries a "Preview" badge
//     dated May 13, 2025, still gated over a year later.
//   - The only two action types confirmed via public search results,
//     `send-user-message` and `redact-tool-input`, are declarative JSON
//     actions, not a documented "run this external script and read its
//     stdout/exit code for a permission decision" action -- the mechanism
//     gateguard-fact-force.js's CLI entrypoint relies on for every other
//     target wired in this repo (Claude Code, Gemini CLI, CodeBuddy, VS Code
//     Copilot, Antigravity).
// Wiring against an internal-only, unconfirmed schema would risk shipping a
// hook that silently never fires. Revisit if ampcode.com/manual publishes
// the hooks section publicly.

module.exports = createInstallTargetAdapter({
  id: 'amp-home',
  target: 'amp',
  kind: 'home',
  rootSegments: ['.amp'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.amp',
  planOperations: createFlatSkillPlanOperations,
});
