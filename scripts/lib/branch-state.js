'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_BRANCH_FILE = 'main.md';

function getStateDir(homeDir) {
  return path.join(homeDir || os.homedir(), '.egc', 'state');
}

function projectSlug(projectPath) {
  const parts = projectPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
}

function sanitizeBranchName(branch) {
  return branch.replace(/\//g, '-').replace(/[^a-zA-Z0-9-_]/g, '_');
}

function detectBranch(projectPath) {
  try {
    const output = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    // Detached HEAD reports the literal string "HEAD"; treat it as no branch
    if (!output || output === 'HEAD') return null;
    return output;
  } catch (_) {
    return null;
  }
}

function flatStateFile(stateDir, projectPath) {
  return path.join(stateDir, `${projectSlug(projectPath)}.md`);
}

function branchStateFile(stateDir, projectPath, branch) {
  return path.join(stateDir, projectSlug(projectPath), `${sanitizeBranchName(branch)}.md`);
}

function resolveStateRead(stateDir, projectPath, branch) {
  if (branch) {
    const branchFile = branchStateFile(stateDir, projectPath, branch);
    if (fs.existsSync(branchFile)) {
      return { filePath: branchFile, source: 'branch', branch };
    }
    const defaultFile = path.join(stateDir, projectSlug(projectPath), DEFAULT_BRANCH_FILE);
    if (fs.existsSync(defaultFile)) {
      return { filePath: defaultFile, source: 'default-branch', branch };
    }
  }

  const flatFile = flatStateFile(stateDir, projectPath);
  if (fs.existsSync(flatFile)) {
    return { filePath: flatFile, source: 'flat', branch: branch || null };
  }

  return {
    filePath: branch ? branchStateFile(stateDir, projectPath, branch) : flatFile,
    source: 'none',
    branch: branch || null,
  };
}

function resolveStateWrite(stateDir, projectPath, branch) {
  if (branch) return branchStateFile(stateDir, projectPath, branch);
  return flatStateFile(stateDir, projectPath);
}

module.exports = {
  DEFAULT_BRANCH_FILE,
  getStateDir,
  projectSlug,
  sanitizeBranchName,
  detectBranch,
  flatStateFile,
  branchStateFile,
  resolveStateRead,
  resolveStateWrite,
};
