const { createInstallTargetAdapter, createRemappedOperation } = require('./helpers');
const { createOpenHandsGuardianOperations } = require('../openhands-guardian-operations');

// EGC-498 (corrected): confirmed against OpenHands/docs' own hooks.mdx
// that .openhands/hooks.json is project-only (no global/home path
// documented) -- this adapter installs ONLY the Guardian hook there. No
// skill scaffold here: OpenHands skill discovery already happens via
// openhands-home.js's shared ~/.agents/skills/ root, and inventing a
// second, project-scoped skill path was never part of this integration's
// scope. Registered AFTER openhands-home.js in registry.js's ADAPTERS
// array so the bare 'openhands' target keeps resolving to the home
// adapter by default; this one is reached via direct id lookup
// ('openhands-project'), the same second-class-but-real status
// kiro-project.js already has relative to kiro-home.js.
module.exports = createInstallTargetAdapter({
  id: 'openhands-project',
  target: 'openhands',
  kind: 'project',
  rootSegments: ['.openhands'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.openhands',
  planOperations(input, adapter) {
    const planningInput = { repoRoot: input.repoRoot, projectRoot: input.projectRoot, homeDir: input.homeDir };
    const targetRoot = adapter.resolveRoot(planningInput);
    return createOpenHandsGuardianOperations(adapter, targetRoot, input.projectRoot, createRemappedOperation);
  },
});
