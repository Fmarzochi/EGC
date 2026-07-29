const path = require('node:path');
const { createInstallTargetAdapter, createRemappedOperation, isForeignPlatformPath } = require('./helpers');
const { createAmazonQGuardianOperations } = require('../amazonq-guardian-operations');

// Same default-scaffold behavior createInstallTargetAdapter would otherwise
// supply on its own (preserve category structure, no flat stripping) --
// replicated here, not deleted, because defining a custom planOperations
// below (needed to also emit the Guardian operations) replaces that
// built-in default entirely.
function createDefaultScaffoldOperations(input, adapter) {
  if (Array.isArray(input.modules)) {
    return input.modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(p => !isForeignPlatformPath(p, adapter.target))
        .map(sourceRelativePath => adapter.createScaffoldOperation(module.id, sourceRelativePath, input));
    });
  }

  const module = input.module || {};
  const paths = Array.isArray(module.paths) ? module.paths : [];
  return paths
    .filter(p => !isForeignPlatformPath(p, adapter.target))
    .map(sourceRelativePath => adapter.createScaffoldOperation(module.id, sourceRelativePath, input));
}

// EGC-498 (corrected): Amazon Q Developer CLI's preToolUse hook is real
// (confirmed against aws/amazon-q-developer-cli's own docs -- the earlier
// Multica report classifying it as prompt-only was wrong). The custom-agent
// config lives at .amazonq/cli-agents/*.json, a sibling of the rules/ root
// this adapter already scaffolds, not nested inside it -- so the Guardian
// operations resolve their own root from the .amazonq parent directory
// rather than the rules-scoped targetRoot the skill scaffold uses.
module.exports = createInstallTargetAdapter({
  id: 'amazonq-project',
  target: 'amazonq',
  kind: 'project',
  rootSegments: ['.amazonq', 'rules'],
  installStatePathSegments: ['egc-install-state.json'],
  // rootSegments already ends in 'rules', matching rules-core's own module
  // path ('rules'): nativeRootRelativePath must equal that source path (not
  // '.amazonq', never exercised by any module) so resolveDestinationPath
  // syncs root children directly instead of nesting rules/rules/.
  nativeRootRelativePath: 'rules',
  planOperations(input, adapter) {
    const planningInput = { repoRoot: input.repoRoot, projectRoot: input.projectRoot, homeDir: input.homeDir };
    const rulesRoot = adapter.resolveRoot(planningInput);
    const amazonQRoot = path.dirname(rulesRoot);
    return [
      ...createDefaultScaffoldOperations(input, adapter),
      ...createAmazonQGuardianOperations(adapter, amazonQRoot, createRemappedOperation),
    ];
  },
});
