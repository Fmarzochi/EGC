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

// Auggie (Augment Code's terminal agent) reads skills, commands and rules
// natively under ~/.augment, confirmed against docs.augmentcode.com/cli
// (2026-10-09): skills flat at ~/.augment/skills/<name>/SKILL.md (also
// compatible with ~/.claude/skills and ~/.agents/skills, but .augment is
// its own canonical location and the one every other EGC target's shape
// maps onto directly); commands flat at ~/.augment/commands/<name>.md;
// rules recursively under ~/.augment/rules/*.md, always treated as
// always_apply there regardless of frontmatter (the `type` key only
// changes behavior for workspace rules). No hook or plugin API with an
// allow/deny decision is documented -- --startup-script runs once before
// the session, not per tool call -- so the Guardian and the Token Crusher
// stay out of scope here, same as Kiro and Devin Desktop. Agents have no
// native equivalent (its --persona flag selects a built-in persona id, not
// a catalog of markdown files), so they fall through to the default
// scaffold as a plain library folder under .augment/agents/, same as every
// family a target cannot run natively.
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
  id: 'auggie-home',
  target: 'auggie',
  kind: 'home',
  rootSegments: ['.augment'],
  installStatePathSegments: ['egc', 'install-state.json'],
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
