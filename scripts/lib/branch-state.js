'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const DEFAULT_BRANCH_FILE = 'main.md';
const BRANCH_FILE_PREFIX_LENGTH = 120;

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

// Sanitization alone is not injective: feature/auth and feature-auth both
// become feature-auth. Keep a readable prefix, then bind it to the exact ref.
function branchStateKey(branch) {
  const branchName = String(branch || '');
  const readablePrefix = sanitizeBranchName(branchName).slice(0, BRANCH_FILE_PREFIX_LENGTH) || 'branch';
  const digest = createHash('sha256').update(branchName, 'utf8').digest('hex');
  return `${readablePrefix}--${digest}`;
}

// What sits at a path that does not resolve: 'absent' (nothing there, or
// a parent that is not a directory), 'link' (a link, a dangling one
// included: never appended lexically, since a target created or moved
// later would redirect it past the check), or 'unknown' when the path
// cannot be inspected at all, which the caller treats like a link.
function unresolvedComponent(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink() ? 'link' : 'plain';
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'absent' : 'unknown';
  }
}

// The canonical absolute form of a path: links are resolved through the
// nearest existing ancestor and the rest is appended lexically, so a link
// planted at .git or above it cannot lead a read outside the trusted roots
// while the lexical path still looks inside them. A path that cannot be
// canonicalised (a link loop, a dangling link on the way, a parent that
// cannot be inspected) is null.
function canonicalPath(p) {
  let existing = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(existing);
      return tail.length > 0 ? path.join(real, ...tail) : real;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null;
    }
    const component = unresolvedComponent(existing);
    if (component === 'link' || component === 'unknown') return null;
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
}

function withTrailingSeparator(dir) {
  return dir.endsWith(path.sep) ? dir : dir + path.sep;
}

function trustedRoot(dir) {
  try {
    return withTrailingSeparator(fs.realpathSync.native(dir));
  } catch {
    return withTrailingSeparator(path.resolve(dir));
  }
}

// The canonical absolute form of a git path when it sits under a trusted
// root (the home directory or the temp directory, untainted system values)
// and carries '.git' as a path segment; null otherwise. The value returned
// here is the one every read below uses, so a path handed in by a hook
// payload or a CLI argument never reaches the filesystem unchecked, and a
// traversal or a link leading to an unrelated location is refused before
// any read.
function trustedGitPath(p) {
  const canonical = canonicalPath(p);
  if (!canonical) return null;
  const underTrustedRoot = canonical.startsWith(trustedRoot(os.homedir())) || canonical.startsWith(trustedRoot(os.tmpdir()));
  const hasGitSegment = canonical.split(path.sep).includes('.git');
  return underTrustedRoot && hasGitSegment ? canonical : null;
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
    let gitDir = trustedGitPath(rawGitDir);
    if (!gitDir) return null;
    if (fs.statSync(gitDir).isFile()) {
      // Worktrees and submodules store a pointer file instead of a directory
      const pointer = fs.readFileSync(gitDir, 'utf8').trim();
      if (!pointer.startsWith('gitdir:')) return null;
      gitDir = trustedGitPath(path.resolve(path.dirname(gitDir), pointer.slice('gitdir:'.length).trim()));
      if (!gitDir) return null;
    }
    const headPath = trustedGitPath(path.resolve(gitDir, 'HEAD'));
    if (!headPath) return null;
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
  return path.join(stateDir, projectSlug(projectPath), `${branchStateKey(branch)}.md`);
}

function legacyBranchStateFile(stateDir, projectPath, branch) {
  return path.join(stateDir, projectSlug(projectPath), `${sanitizeBranchName(branch)}.md`);
}

function resolveStateRead(stateDir, projectPath, branch) {
  if (branch) {
    const branchFile = branchStateFile(stateDir, projectPath, branch);
    if (fs.existsSync(branchFile)) {
      return { filePath: branchFile, source: 'branch', branch };
    }
    const legacyBranchFile = legacyBranchStateFile(stateDir, projectPath, branch);
    if (fs.existsSync(legacyBranchFile)) {
      return { filePath: legacyBranchFile, source: 'branch', branch };
    }
    // Current versions write the default branch under its hashed key, so the
    // fallback must look there first; the plain main.md name is only left
    // behind by pre-hash versions and would otherwise shadow newer state.
    const defaultHashedFile = branchStateFile(stateDir, projectPath, 'main');
    if (fs.existsSync(defaultHashedFile)) {
      return { filePath: defaultHashedFile, source: 'default-branch', branch };
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
  branchStateKey,
  detectBranch,
  trustedGitPath,
  flatStateFile,
  branchStateFile,
  legacyBranchStateFile,
  resolveStateRead,
  resolveStateWrite,
};
