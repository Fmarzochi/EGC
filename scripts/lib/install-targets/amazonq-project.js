const path = require('node:path');
const { createDefaultScaffoldOperations, createInstallTargetAdapter, createRemappedOperation } = require('./helpers');
const { createAmazonQGuardianOperations } = require('../amazonq-guardian-operations');

// EGC-498 (corrected): Amazon Q Developer CLI's preToolUse hook is real
// (confirmed against aws/amazon-q-developer-cli's own docs -- the earlier
// earlier internal report classifying it as prompt-only was wrong). The custom-agent
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
