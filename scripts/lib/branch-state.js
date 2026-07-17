'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_BRANCH_FILE = 'main.md';

function getStateDir(homeDir) {
  return path.join(homeDir || os.homedir(), '.egc', 'state');
}

function projectSlug(projectPath) {
  const parts = projectPath.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
}

function sanitizeBranchName(branch) {
  return branch.replaceAll('/', '-').replace(/[^a-zA-Z0-9-_]/g, '_');
}

// Validates a resolved absolute path is within a trusted directory root
// (home or tmp) and contains '.git' as a path segment. Using startsWith
// against os.homedir()/os.tmpdir() -- which are untainted system values --
// satisfies SonarCloud's path-injection sanitization requirement and also
// prevents traversal to unrelated filesystem locations.
function isGitRelatedPath(p) {
  const resolved = path.resolve(p);
  const home = os.homedir() + path.sep;
  const tmp = os.tmpdir() + path.sep;
  const underTrustedRoot = resolved.startsWith(home) || resolved.startsWith(tmp);
  const hasGitSegment = resolved.split(path.sep).includes('.git');
  return underTrustedRoot && hasGitSegment;
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
    if (!isGitRelatedPath(headPath)) return null;
    const head = fs.readFileSync(headPath, 'utf8').trim();
    const refPrefix = 'ref: refs/heads/';
    // Detached HEAD stores a bare commit hash; treat it as no branch
    if (!head.startsWith(refPrefix)) return null;
    return head.slice(refPrefix.length) || null;
  } catch (_) { // NOSONAR: unreadable .git/HEAD means no branch info available
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
