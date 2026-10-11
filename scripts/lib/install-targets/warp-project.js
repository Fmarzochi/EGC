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
const MEMORY_RULE_SOURCE = 'rules/common/memory.md';
const LEGACY_MEMORY_INDEX_NAME = 'EGC Session Memory';

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

function readMemoryRule(repoRoot) {
  const sourcePath = path.join(repoRoot || '', ...MEMORY_RULE_SOURCE.split('/'));
  try {
    return fs.readFileSync(sourcePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read the memory rule for Warp at ${sourcePath}: ${error.message}`, { cause: error });
  }
}

function selectRulesFile(projectRoot) {
  const warpFile = path.join(projectRoot, 'WARP.md');
  const stat = fs.lstatSync(warpFile, { throwIfNoEntry: false });
  return stat?.isFile() ? warpFile : path.join(projectRoot, 'AGENTS.md');
}

function planMemoryRuleOperations(moduleId, context) {
  const base = {
    kind: MERGE_MARKDOWN_INDEX_KIND,
    moduleId,
    sourceRelativePath: MEMORY_RULE_SOURCE,
    strategy: MERGE_MARKDOWN_INDEX_KIND,
    ownership: 'managed',
    scaffoldOnly: false,
  };
  const operations = context.indexedSkillNames.has(LEGACY_MEMORY_INDEX_NAME)
    ? [{ ...base, destinationPath: context.agentsFilePath, skillName: LEGACY_MEMORY_INDEX_NAME, removeEntry: true }]
    : [];
  const movedFrom = new Set(context.previousOperations
    .filter(operation => operation.memoryRule && !operation.removeEntry && operation.destinationPath !== context.rulesFilePath)
    .map(operation => operation.destinationPath));
  for (const destinationPath of movedFrom) {
    operations.push({ ...base, destinationPath, memoryRule: true, removeEntry: true });
  }
  operations.push({ ...base, destinationPath: context.rulesFilePath, memoryRule: true, ruleContent: readMemoryRule(context.repoRoot) });
  return operations;
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
  const previousOperations = Array.isArray(previousState?.operations) ? previousState.operations : [];
  const indexedSkillNames = new Set(previousOperations
    .filter(operation => operation.kind === MERGE_MARKDOWN_INDEX_KIND && !operation.removeEntry && operation.skillName)
    .map(operation => operation.skillName));
  const memoryRuleContext = {
    repoRoot: input.repoRoot,
    agentsFilePath,
    rulesFilePath: selectRulesFile(projectRoot),
    previousOperations,
    indexedSkillNames,
  };

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

        // rules-core's memory protocol (rules/common/memory.md) has to be
        // loaded every session, and Warp loads only AGENTS.md (or WARP.md,
        // which wins when both exist), so its text goes into a marked block
        // of whichever of the two Warp reads.
        if (normalized === 'rules') {
          return planMemoryRuleOperations(module.id, memoryRuleContext);
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
    if (!input.projectRoot && !input.repoRoot) return [];
    if (collectRecordedDestinations(adapter, input)) return [];
    return [buildValidationIssue(
      'warning',
      'install-state-unreadable',
      `The install state at ${adapter.getInstallStatePath(input)} cannot be read: skills already under ${path.join(adapter.resolveRoot(input), 'skills')} that differ from EGC's are treated as yours and left as they are until it can be read again.`
    )];
  },
  planOperations: createWarpPlanOperations,
});
