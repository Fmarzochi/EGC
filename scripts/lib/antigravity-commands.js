'use strict';

const path = require('node:path');

const { ANTIGRAVITY_COMMAND_SKILL_TRANSFORM } = require('./install/copy-transforms');
const { assertUniqueFileNames, listSourceFiles, normalizeSourcePath } = require('./antigravity-rules');

function isCommandSource(sourceRelativePath) {
  const normalized = normalizeSourcePath(sourceRelativePath);
  return normalized === 'commands' || normalized.startsWith('commands/');
}

function commandSkillName(sourceRelativeFile) {
  const relative = normalizeSourcePath(sourceRelativeFile).slice('commands/'.length);
  const baseName = path.posix.basename(relative).toLowerCase();
  if (baseName === 'readme.md' || !baseName.endsWith('.md')) {
    return null;
  }
  return relative.slice(0, -'.md'.length).replaceAll('/', '-');
}

function planCommandSkillFiles(repoRoot, sourceRelativePath, transform) {
  if (!repoRoot) {
    return [];
  }
  return assertUniqueFileNames(listSourceFiles(repoRoot, normalizeSourcePath(sourceRelativePath))
    .map(sourceRelativeFile => {
      const name = commandSkillName(sourceRelativeFile);
      return {
        sourceRelativePath: sourceRelativeFile,
        fileName: name ? `${name}/SKILL.md` : null,
        transform,
      };
    })
    .filter(command => command.fileName));
}

function planAntigravityCommandFiles(repoRoot, sourceRelativePath) {
  return planCommandSkillFiles(repoRoot, sourceRelativePath, ANTIGRAVITY_COMMAND_SKILL_TRANSFORM);
}

function assertUniqueCommandSkills(operations, transform = ANTIGRAVITY_COMMAND_SKILL_TRANSFORM) {
  const owners = new Map();
  for (const operation of operations.filter(candidate => candidate.transform === transform)) {
    const destination = path.resolve(operation.destinationPath);
    const source = normalizeSourcePath(operation.sourceRelativePath);
    const owner = owners.get(destination);
    if (owner && owner !== source) {
      throw new Error(`${owner} and ${source} would both install as ${destination}`);
    }
    owners.set(destination, source);
  }
}

function dropCommandsShadowedBySkills(operations) {
  assertUniqueCommandSkills(operations);
  const skillDestinations = operations
    .filter(operation => normalizeSourcePath(operation.sourceRelativePath).startsWith('skills/'))
    .map(operation => path.resolve(operation.destinationPath));
  const isShadowed = directory => skillDestinations.some(destination => (
    destination === directory || destination.startsWith(directory + path.sep)
  ));
  return operations.filter(operation => !(
    operation.transform === ANTIGRAVITY_COMMAND_SKILL_TRANSFORM
    && isShadowed(path.resolve(path.dirname(operation.destinationPath)))
  ));
}

module.exports = {
  assertUniqueCommandSkills,
  dropCommandsShadowedBySkills,
  isCommandSource,
  planAntigravityCommandFiles,
  planCommandSkillFiles,
};
