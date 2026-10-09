const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  buildValidationIssue,
  collectRecordedDestinations,
  createInstallTargetAdapter,
  createManagedOperation,
  isForeignPlatformPath,
  isPersonOwnedDestination,
  normalizeRelativePath,
  readInstallStateOrNull,
} = require('./helpers');
const { MERGE_MARKDOWN_INDEX_KIND } = require('../warp-agents-merge');

const MAX_DESCRIPTION_LENGTH = 110;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;

// Warp discovers skills natively as .warp/skills/<name>/SKILL.md
// (docs.warp.dev/agents/capabilities/skills), so each skill directory is
// copied whole there. A 'merge-markdown-skill-index' operation keeps a
// one-line entry (name + short description + path) in a marked block of the
// project's AGENTS.md, without touching any of the user's own content in
// that file.

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
  } catch (_error) { // NOSONAR
    // ignore: missing or unreadable SKILL.md safely results in an empty description
    return '';
  }

  const frontmatterMatch = FRONTMATTER_PATTERN.exec(content);
  if (!frontmatterMatch) {
    return '';
  }

  let frontmatter;
  try {
    frontmatter = yaml.load(frontmatterMatch[1]);
  } catch (_error) { // NOSONAR
    // ignore: malformed YAML frontmatter safely results in an empty description
    return '';
  }

  if (!frontmatter || typeof frontmatter.description !== 'string') {
    return '';
  }

  return truncateDescription(frontmatter.description.trim().replace(/\s+/g, ' '));
}

function isSymbolicLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function createWarpPlanOperations(input, adapter) {
  // Deliberately NOT using helpers.js's normalizeModulesInput() here (EGC-539
  // audit): same reasoning as aider-project.js's createAiderPlanOperations --
  // that shared helper also falls back to a singular `input.module`, which
  // this adapter has never supported and has no test coverage exercising
  // (unlike trae-project.js's direct-call fallback test). Left as the
  // array-only variant on purpose rather than silently widening this
  // adapter's observable contract.
  const modules = Array.isArray(input.modules) ? input.modules : [];
  const planningInput = {
    repoRoot: input.repoRoot,
    projectRoot: input.projectRoot,
    homeDir: input.homeDir,
  };
  const targetRoot = adapter.resolveRoot(planningInput);
  const projectRoot = input.projectRoot || input.repoRoot;
  const agentsFilePath = path.join(projectRoot, 'AGENTS.md');
  const recordedDestinations = collectRecordedDestinations(adapter, planningInput);
  const previousState = readInstallStateOrNull(adapter.getInstallStatePath(planningInput));
  const indexedSkillNames = new Set((Array.isArray(previousState?.operations) ? previousState.operations : [])
    .filter(operation => operation.kind === MERGE_MARKDOWN_INDEX_KIND && !operation.removeEntry && operation.skillName)
    .map(operation => operation.skillName));

  return modules.flatMap(module => {
    const paths = Array.isArray(module.paths) ? module.paths : [];
    return paths
      .filter(p => !isForeignPlatformPath(p, adapter.target))
      .flatMap(sourceRelativePath => {
        const normalized = normalizeRelativePath(sourceRelativePath);

        if (normalized.startsWith('skills/')) {
          const skillName = normalized.split('/').pop();
          const skillDir = path.join(targetRoot, 'skills', skillName);
          const sourceSkillDir = input.repoRoot ? path.join(input.repoRoot, normalized) : null;
          if (isSymbolicLink(skillDir) || isPersonOwnedDestination(skillDir, sourceSkillDir, recordedDestinations)) {
            return indexedSkillNames.has(skillName) ? [{
              kind: MERGE_MARKDOWN_INDEX_KIND,
              moduleId: module.id,
              sourceRelativePath: path.join(normalized, 'SKILL.md'),
              destinationPath: agentsFilePath,
              strategy: MERGE_MARKDOWN_INDEX_KIND,
              ownership: 'managed',
              scaffoldOnly: false,
              skillName,
              removeEntry: true,
            }] : [];
          }
          const sourceSkillPath = path.join(input.repoRoot || '', normalized, 'SKILL.md');

          const copyOperation = createManagedOperation({
            moduleId: module.id,
            sourceRelativePath: normalized,
            destinationPath: skillDir,
            strategy: 'preserve-relative-path',
          });

          const mergeOperation = {
            kind: MERGE_MARKDOWN_INDEX_KIND,
            moduleId: module.id,
            // install-state.schema.json requires sourceRelativePath on every
            // operation; the executor's merge-kind branch doesn't read it
            // (materializeScaffoldOperation just spreads the operation
            // through), but the schema check on the recorded install-state
            // fails without it. Point at the same source the copy operation
            // above already used.
            sourceRelativePath: path.join(normalized, 'SKILL.md'),
            destinationPath: agentsFilePath,
            strategy: MERGE_MARKDOWN_INDEX_KIND,
            ownership: 'managed',
            scaffoldOnly: false,
            skillName,
            skillDescription: readSkillDescription(sourceSkillPath),
            relativePath: normalizeRelativePath(path.relative(projectRoot, path.join(skillDir, 'SKILL.md'))),
          };

          return [copyOperation, mergeOperation];
        }

        // rules-core's static memory protocol file (rules/common/memory.md,
        // the get_state/update_state instructions). Warp has no separate
        // rules-discovery mechanism either, so it goes through the same
        // skill-index merge into AGENTS.md as a named entry pointing at the
        // copied file -- consistent with how skills stay out of the
        // always-loaded file to protect context budget. Hardcodes the
        // single known file under rules/ rather than a recursive scan,
        // since that's the only file the module ships today.
        if (normalized === 'rules') {
          const destinationPath = path.join(targetRoot, 'rules', 'common', 'memory.md');

          const copyOperation = createManagedOperation({
            moduleId: module.id,
            sourceRelativePath: 'rules/common/memory.md',
            destinationPath,
            strategy: 'preserve-relative-path',
          });

          const mergeOperation = {
            kind: MERGE_MARKDOWN_INDEX_KIND,
            moduleId: module.id,
            sourceRelativePath: 'rules/common/memory.md',
            destinationPath: agentsFilePath,
            strategy: MERGE_MARKDOWN_INDEX_KIND,
            ownership: 'managed',
            scaffoldOnly: false,
            skillName: 'EGC Session Memory',
            skillDescription: 'Cross-session memory protocol: call get_state at session start, update_state at session end.',
            relativePath: normalizeRelativePath(path.relative(projectRoot, destinationPath)),
          };

          return [copyOperation, mergeOperation];
        }

        return [];
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
  validateMore(input, adapter) {
    if (collectRecordedDestinations(adapter, input)) return [];
    return [buildValidationIssue(
      'warning',
      'install-state-unreadable',
      `The install state at ${adapter.getInstallStatePath(input)} cannot be read: skills already under ${path.join(adapter.resolveRoot(input), 'skills')} that differ from EGC's are treated as yours and left as they are until it can be read again.`
    )];
  },
  planOperations: createWarpPlanOperations,
});
