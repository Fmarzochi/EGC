const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const {
  createInstallTargetAdapter,
  createManagedOperation,
  isForeignPlatformPath,
  normalizeRelativePath,
} = require('./helpers');
const { MERGE_MARKDOWN_INDEX_KIND } = require('../warp-agents-merge');

const MAX_DESCRIPTION_LENGTH = 110;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;

// Warp has no directory-of-files skill discovery: it only reads a single
// root AGENTS.md (or legacy WARP.md) as project rules. So this adapter does
// two things per skill: (1) copy the skill's SKILL.md into
// .warp/skills/<name>.md (flat, full content, read on demand -- Warp's agent
// has normal filesystem access), and (2) emit a 'merge-markdown-skill-index'
// operation that adds a one-line index entry (name + short description +
// path) into a marked block inside the project's AGENTS.md, without
// touching any of the user's own content in that file.

// Truncates on Unicode code points, not UTF-16 code units, so a surrogate
// pair (e.g. an emoji used in a skill description) is never split in half.
function truncateDescription(text) {
  const codePoints = Array.from(text);
  if (codePoints.length <= MAX_DESCRIPTION_LENGTH) {
    return text;
  }
  return `${codePoints.slice(0, MAX_DESCRIPTION_LENGTH - 1).join('')}…`;
}

function readSkillDescription(sourcePath) {
  let content;
  try {
    content = fs.readFileSync(sourcePath, 'utf8');
  } catch (_error) {
    return '';
  }

  const frontmatterMatch = FRONTMATTER_PATTERN.exec(content);
  if (!frontmatterMatch) {
    return '';
  }

  let frontmatter;
  try {
    frontmatter = yaml.load(frontmatterMatch[1]);
  } catch (_error) {
    return '';
  }

  if (!frontmatter || typeof frontmatter.description !== 'string') {
    return '';
  }

  return truncateDescription(frontmatter.description.trim().replace(/\s+/g, ' '));
}

function createWarpPlanOperations(input, adapter) {
  const modules = Array.isArray(input.modules) ? input.modules : [];
  const planningInput = {
    repoRoot: input.repoRoot,
    projectRoot: input.projectRoot,
    homeDir: input.homeDir,
  };
  const targetRoot = adapter.resolveRoot(planningInput);
  const projectRoot = input.projectRoot || input.repoRoot;
  const agentsFilePath = path.join(projectRoot, 'AGENTS.md');

  return modules.flatMap(module => {
    const paths = Array.isArray(module.paths) ? module.paths : [];
    return paths
      .filter(p => !isForeignPlatformPath(p, adapter.target))
      .filter(p => normalizeRelativePath(p).startsWith('skills/'))
      .flatMap(sourceRelativePath => {
        const normalized = normalizeRelativePath(sourceRelativePath);
        const skillName = normalized.split('/').pop();
        const destinationPath = path.join(targetRoot, 'skills', `${skillName}.md`);
        const sourceSkillPath = path.join(input.repoRoot || '', normalized, 'SKILL.md');

        const copyOperation = createManagedOperation({
          moduleId: module.id,
          sourceRelativePath: path.join(normalized, 'SKILL.md'),
          destinationPath,
          strategy: 'preserve-relative-path',
        });

        const mergeOperation = {
          kind: MERGE_MARKDOWN_INDEX_KIND,
          moduleId: module.id,
          destinationPath: agentsFilePath,
          strategy: MERGE_MARKDOWN_INDEX_KIND,
          ownership: 'managed',
          scaffoldOnly: false,
          skillName,
          skillDescription: readSkillDescription(sourceSkillPath),
          relativePath: path.relative(projectRoot, destinationPath),
        };

        return [copyOperation, mergeOperation];
      });
  });
}

module.exports = createInstallTargetAdapter({
  id: 'warp-project',
  target: 'warp',
  kind: 'project',
  rootSegments: ['.warp'],
  installStatePathSegments: ['egc-install-state.json'],
  nativeRootRelativePath: '.warp',
  planOperations: createWarpPlanOperations,
});
