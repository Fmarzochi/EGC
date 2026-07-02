'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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

// Validates a resolved absolute path belongs to a git repository by
// requiring '.git' to appear as a directory segment, blocking traversal
// to unrelated filesystem locations.
function isGitRelatedPath(p) {
  return path.resolve(p).split(path.sep).includes('.git');
}

// Branch detection reads .git/HEAD instead of spawning git: no PATH
// lookup and it works on machines without git installed.
function findGitDir(startPath) {
  let current = path.resolve(startPath);
  for (;;) {
    const candidate = path.join(current, '.git');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function detectBranch(projectPath) {
  try {
    const rawGitDir = findGitDir(projectPath);
    if (!rawGitDir) return null;
    let gitDir = path.resolve(rawGitDir);
    if (!isGitRelatedPath(gitDir)) return null;
    if (fs.statSync(gitDir).isFile()) {
      // Worktrees and submodules store a pointer file instead of a directory
      const pointer = fs.readFileSync(gitDir, 'utf8').trim();
      if (!pointer.startsWith('gitdir:')) return null;
      gitDir = path.resolve(path.dirname(gitDir), pointer.slice('gitdir:'.length).trim());
      if (!isGitRelatedPath(gitDir)) return null;
    }
    const headPath = path.resolve(gitDir, 'HEAD');
    const head = fs.readFileSync(headPath, 'utf8').trim();
    const refPrefix = 'ref: refs/heads/';
    // Detached HEAD stores a bare commit hash; treat it as no branch
    if (!head.startsWith(refPrefix)) return null;
    return head.slice(refPrefix.length) || null;
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
