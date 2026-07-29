const { createInstallTargetAdapter, createRemappedOperation } = require('./helpers');
const { createAmazonQGuardianOperations } = require('../amazonq-guardian-operations');

// EGC-498 (corrected): confirmed against aws/amazon-q-developer-cli's own
// docs that global custom agents live at ~/.aws/amazonq/cli-agents/*.json,
// independent of the project-scoped rules/ root amazonq-project.js already
// scaffolds. This adapter installs ONLY the Guardian hook at that global
// scope -- no skill/rules scaffold here, since Amazon Q's existing rules
// distribution was always project-scoped by design, and a global rules
// path was never part of this integration's original scope.
//
// target is 'amazonq' (same string as amazonq-project.js, not a distinct
// 'amazonq-home'), matching the established Kiro/Windsurf/Continue
// convention of a shared target string across a host's home+project pair.
// Registered AFTER amazonq-project.js in registry.js's ADAPTERS array so
// the bare 'amazonq' target (the only string the top-level CLI's --target
// flag accepts, confirmed empirically -- adapter ids like 'kiro-project'
// are rejected there) keeps resolving to the project adapter by default,
// preserving existing behavior and tests; this adapter is reached via
// direct id lookup ('amazonq-home'), the same second-class-but-real status
// kiro-project.js already has relative to kiro-home.js.
module.exports = createInstallTargetAdapter({
  id: 'amazonq-home',
  target: 'amazonq',
  kind: 'home',
  rootSegments: ['.aws', 'amazonq'],
  installStatePathSegments: ['egc', 'install-state.json'],
  nativeRootRelativePath: '.aws/amazonq',
  planOperations(input, adapter) {
    const planningInput = { repoRoot: input.repoRoot, projectRoot: input.projectRoot, homeDir: input.homeDir };
    const targetRoot = adapter.resolveRoot(planningInput);
    return createAmazonQGuardianOperations(adapter, targetRoot, createRemappedOperation);
  },
});
