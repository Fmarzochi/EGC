const path = require('path');

const {
  createFlatRuleOperations,
  createInstallTargetAdapter,
  createRemappedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
} = require('./helpers');
const {
  createPreToolUseGateGuardHookMergeOperation,
} = require('../claude-settings-hooks');

// CodeBuddy's PreToolUse hooks read from <project>/.codebuddy/settings.json
// using the same {"hooks": {"PreToolUse": [{"matcher", "hooks"}]}} shape
// Claude Code uses (https://www.codebuddy.ai/docs/cli/hooks), and this
// adapter's own targetRoot already resolves to <project>/.codebuddy -- the
// same root the hooks-runtime module scaffolds scripts/hooks/
// gateguard-fact-force.js and scripts/lib/utils.js into. So the generic
// Claude merge helper is reusable here without modification.
function createGateGuardOperations(targetRoot) {
  return [
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'Edit'),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'Write'),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'MultiEdit'),
    createPreToolUseGateGuardHookMergeOperation(targetRoot, 'Bash'),
  ];
}

module.exports = createInstallTargetAdapter({
  id: 'codebuddy-project',
  target: 'codebuddy',
  kind: 'project',
  rootSegments: ['.codebuddy'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.codebuddy',
  planOperations(input, adapter) {
    const modules = Array.isArray(input.modules)
      ? input.modules
      : (input.module ? [input.module] : []);
    const {
      repoRoot,
      projectRoot,
      homeDir,
    } = input;
    const planningInput = {
      repoRoot,
      projectRoot,
      homeDir,
    };
    const targetRoot = adapter.resolveRoot(planningInput);

    const moduleOperations = modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(p => !isForeignPlatformPath(p, adapter.target))
        .flatMap(sourceRelativePath => {
          const normalizedPath = normalizeRelativePath(sourceRelativePath);

          if (sourceRelativePath === 'rules') {
            return createFlatRuleOperations({
              moduleId: module.id,
              repoRoot,
              sourceRelativePath,
              destinationDir: path.join(targetRoot, 'rules'),
            });
          }

          // CodeBuddy discovers skills at .codebuddy/skills/<name>/ (flat).
          // Strip the leading category segment to match the expected structure.
          if (normalizedPath.startsWith('skills/')) {
            const parts = normalizedPath.slice('skills/'.length).split('/');
            const flatRemainder = parts.length >= 2 ? parts.slice(1).join('/') : parts.join('/');
            return [
              createRemappedOperation(
                adapter,
                module.id,
                sourceRelativePath,
                path.join(targetRoot, 'skills', flatRemainder),
                { strategy: 'preserve-relative-path' }
              ),
            ];
          }

          return [adapter.createScaffoldOperation(module.id, sourceRelativePath, planningInput)];
        });
    });

    // Deterministic: every CodeBuddy install registers the GateGuard
    // fact-forcing gate, even when no content modules are selected,
    // mirroring Claude Code's always-on hook registration.
    return [
      ...moduleOperations,
      ...createGateGuardOperations(targetRoot),
    ];
  },
});
