'use strict';

const path = require('node:path');

const { ANTIGRAVITY_AGENT_FRONTMATTER_TRANSFORM } = require('./install/copy-transforms');
const { listSourceFiles, normalizeSourcePath } = require('./antigravity-rules');

const AGY_AGENTS_SUBDIR = 'config/agents';

function isAgentSource(sourceRelativePath) {
  const normalized = normalizeSourcePath(sourceRelativePath);
  return normalized === 'agents' || normalized.startsWith('agents/');
}

function agentFileName(sourceRelativeFile) {
  const relative = normalizeSourcePath(sourceRelativeFile).slice('agents/'.length);
  const baseName = path.posix.basename(relative).toLowerCase();
  if (baseName === 'readme.md' || !baseName.endsWith('.md')) {
    return null;
  }
  return relative.replaceAll('/', '-');
}

function planAntigravityAgentFiles(repoRoot, sourceRelativePath) {
  if (!repoRoot) {
    return [];
  }
  return listSourceFiles(repoRoot, normalizeSourcePath(sourceRelativePath))
    .map(sourceRelativeFile => ({
      sourceRelativePath: sourceRelativeFile,
      fileName: agentFileName(sourceRelativeFile),
      transform: ANTIGRAVITY_AGENT_FRONTMATTER_TRANSFORM,
    }))
    .filter(agent => agent.fileName);
}

module.exports = {
  AGY_AGENTS_SUBDIR,
  isAgentSource,
  planAntigravityAgentFiles,
};
