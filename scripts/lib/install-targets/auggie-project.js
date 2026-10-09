const path = require('node:path');
const {
  createFlatFileOperations,
  createFlatRuleOperations,
  createInstallTargetAdapter,
  isForeignPlatformPath,
  normalizeRelativePath,
  planFlatSkillOperation,
  resolveModulesPlan,
} = require('./helpers');

// Project-scoped counterpart of auggie-home.js: Auggie reads the same three
// families from the workspace root instead of the home directory (.augment/
// skills, commands and rules), confirmed against the same docs. Workspace
// rules additionally support a `type` frontmatter key (always_apply or
// agent_requested), which EGC's source rule files do not set, so they load
// as always_apply here too -- no transform needed. No hook/plugin surface
// here either (see auggie-home.js), so the Guardian and the Token Crusher
// stay out of scope for this target.
function planAuggieModuleOperations(adapter, moduleId, sourceRelativePath, planningInput, targetRoot) {
  const normalized = normalizeRelativePath(sourceRelativePath);
  if (normalized === 'rules') {
    return createFlatRuleOperations({
      moduleId,
      repoRoot: planningInput.repoRoot,
      sourceRelativePath,
      destinationDir: path.join(targetRoot, 'rules'),
    });
  }
  if (normalized === 'commands') {
    return createFlatFileOperations({
      moduleId,
      repoRoot: planningInput.repoRoot,
      sourceRelativePath,
      destinationDir: path.join(targetRoot, 'commands'),
    });
  }
  return [planFlatSkillOperation(adapter, moduleId, sourceRelativePath, planningInput, targetRoot)];
}

module.exports = createInstallTargetAdapter({
  id: 'auggie-project',
  target: 'auggie',
  kind: 'project',
  rootSegments: ['.augment'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.augment',
  planOperations(input, adapter) {
    const { modules, planningInput, targetRoot } = resolveModulesPlan(input, adapter);
    return modules.flatMap(module => {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      return paths
        .filter(p => !isForeignPlatformPath(p, adapter.target))
        .flatMap(sourceRelativePath => planAuggieModuleOperations(adapter, module.id, sourceRelativePath, planningInput, targetRoot));
    });
  },
});
