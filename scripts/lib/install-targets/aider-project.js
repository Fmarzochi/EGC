const path = require('node:path');

const {
  createInstallTargetAdapter,
  createManagedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
} = require('./helpers');
const { MERGE_YAML_READ_LIST_KIND } = require('../aider-config-merge');

// Aider does not scan a skills directory: it loads context via a `read:`
// key inside .aider.conf.yml (searched in three locations and merged --
// home dir, git repo root, cwd -- per https://aider.chat/docs/config/aider_conf.html).
// So this adapter does two things per skill: (1) copy the skill's SKILL.md
// into .aider/skills/<name>.md (flat, single file -- Aider reads plain
// markdown, not a skill-folder-with-assets convention), and (2) emit a
// 'merge-yaml-read-list' operation that adds that file's path into the
// `read:` list of the project's .aider.conf.yml without touching any of the
// user's own existing keys (model settings, lint commands, etc).

// path.relative() returns backslash-separated paths on Windows; YAML/the
// read: list should stay forward-slash like every other path in this repo.
function toPosixRelative(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function createAiderPlanOperations(input, adapter) {
  const modules = Array.isArray(input.modules) ? input.modules : [];
  const planningInput = {
    repoRoot: input.repoRoot,
    projectRoot: input.projectRoot,
    homeDir: input.homeDir,
  };
  const targetRoot = adapter.resolveRoot(planningInput);
  const projectRoot = input.projectRoot || input.repoRoot;
  const aiderConfigPath = path.join(projectRoot, '.aider.conf.yml');

  return modules.flatMap(module => {
    const paths = Array.isArray(module.paths) ? module.paths : [];
    return paths
      .filter(p => !isForeignPlatformPath(p, adapter.target))
      .flatMap(sourceRelativePath => {
        const normalized = normalizeRelativePath(sourceRelativePath);

        if (normalized.startsWith('skills/')) {
          const skillName = normalized.split('/').pop();
          const destinationPath = path.join(targetRoot, 'skills', `${skillName}.md`);

          const copyOperation = createManagedOperation({
            moduleId: module.id,
            sourceRelativePath: path.join(normalized, 'SKILL.md'),
            destinationPath,
            strategy: 'preserve-relative-path',
          });

          const mergeOperation = {
            kind: MERGE_YAML_READ_LIST_KIND,
            moduleId: module.id,
            // install-state.schema.json requires sourceRelativePath on every
            // operation; the executor's merge-kind branch doesn't read it
            // (materializeScaffoldOperation just spreads the operation
            // through), but the schema check on the recorded install-state
            // fails without it. Point at the same source the copy operation
            // above already used.
            sourceRelativePath: path.join(normalized, 'SKILL.md'),
            destinationPath: aiderConfigPath,
            strategy: MERGE_YAML_READ_LIST_KIND,
            ownership: 'managed',
            scaffoldOnly: false,
            readEntry: toPosixRelative(projectRoot, destinationPath),
          };

          return [copyOperation, mergeOperation];
        }

        // rules-core's static memory protocol file (rules/common/memory.md,
        // the get_state/update_state instructions). Same read: merge
        // mechanism as a skill -- Aider only ever loads context through
        // that one key -- just copied to .aider/rules/ instead of
        // .aider/skills/. Hardcodes the single known file under rules/
        // rather than a recursive scan, since that's the only file the
        // module ships today; revisit if rules/ grows more files.
        if (normalized === 'rules') {
          const memorySourcePath = 'rules/common/memory.md';
          const destinationPath = path.join(targetRoot, 'rules', 'common', 'memory.md');

          const copyOperation = createManagedOperation({
            moduleId: module.id,
            sourceRelativePath: memorySourcePath,
            destinationPath,
            strategy: 'preserve-relative-path',
          });

          const mergeOperation = {
            kind: MERGE_YAML_READ_LIST_KIND,
            moduleId: module.id,
            sourceRelativePath: memorySourcePath,
            destinationPath: aiderConfigPath,
            strategy: MERGE_YAML_READ_LIST_KIND,
            ownership: 'managed',
            scaffoldOnly: false,
            readEntry: toPosixRelative(projectRoot, destinationPath),
          };

          return [copyOperation, mergeOperation];
        }

        return [];
      });
  });
}

module.exports = createInstallTargetAdapter({
  id: 'aider-project',
  target: 'aider',
  kind: 'project',
  rootSegments: ['.aider'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.aider',
  planOperations: createAiderPlanOperations,
});
