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

function planAntigravityCommandFiles(repoRoot, sourceRelativePath) {
  if (!repoRoot) {
    return [];
  }
  return assertUniqueFileNames(listSourceFiles(repoRoot, normalizeSourcePath(sourceRelativePath))
    .map(sourceRelativeFile => {
      const name = commandSkillName(sourceRelativeFile);
      return {
        sourceRelativePath: sourceRelativeFile,
        fileName: name ? `${name}/SKILL.md` : null,
        transform: ANTIGRAVITY_COMMAND_SKILL_TRANSFORM,
      };
    })
    .filter(command => command.fileName));
}

function dropCommandsShadowedBySkills(operations) {
  const skillDirectories = new Set(operations
    .filter(operation => normalizeSourcePath(operation.sourceRelativePath).startsWith('skills/'))
    .map(operation => path.resolve(operation.destinationPath)));
  return operations.filter(operation => !(
    operation.transform === ANTIGRAVITY_COMMAND_SKILL_TRANSFORM
    && skillDirectories.has(path.resolve(path.dirname(operation.destinationPath)))
  ));
}

module.exports = {
  dropCommandsShadowedBySkills,
  isCommandSource,
  planAntigravityCommandFiles,
};
