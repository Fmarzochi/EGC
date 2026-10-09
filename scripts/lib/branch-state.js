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

// Reads the raw, trimmed content of .git/HEAD, resolving worktree and
// submodule pointer files and refusing anything outside the trusted roots.
// Shared by detectBranch and detectDetachedCommit so both agree on exactly
// what HEAD says.
function readHeadLine(projectPath) {
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
    return fs.readFileSync(headPath, 'utf8').trim();
  } catch (_) { // NOSONAR: unreadable .git/HEAD means no branch info available
    return null;
  }
}

function detectBranch(projectPath) {
  const head = readHeadLine(projectPath);
  if (!head) return null;
  const refPrefix = 'ref: refs/heads/';
  // Detached HEAD stores a bare commit hash; treat it as no branch
  if (!head.startsWith(refPrefix)) return null;
  return head.slice(refPrefix.length) || null;
}

// Git object IDs are exactly 40 hex characters (SHA-1) or 64 (SHA-256
// repositories); nothing in between is a real one, so a truncated or
// otherwise corrupted HEAD (e.g. from an interrupted checkout) is refused
// rather than used as a path component.
const DETACHED_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// The commit a detached HEAD points at, or null when HEAD is on a branch,
// outside a git repo, or its content does not look like a commit hash
// (a corrupted .git/HEAD is treated as no detached state, never used as a
// path component).
function detectDetachedCommit(projectPath) {
  const head = readHeadLine(projectPath);
  if (!head || head.startsWith('ref: refs/heads/')) return null;
  return DETACHED_COMMIT_PATTERN.test(head) ? head.toLowerCase() : null;
}

// detectBranch and detectDetachedCommit each read HEAD; pairing them by
// hand at every call site is the exact two-line dance that one call site
// (session-context-loader.js) kept only half of, breaking detached-HEAD
// isolation there. Every resolveStateRead/resolveStateWrite call site
// should get both from here instead.
function resolveHeadState(projectPath) {
  const head = readHeadLine(projectPath);
  if (!head) return { branch: null, detachedCommit: null };
  const refPrefix = 'ref: refs/heads/';
  if (head.startsWith(refPrefix)) {
    return { branch: head.slice(refPrefix.length) || null, detachedCommit: null };
  }
  return { branch: null, detachedCommit: DETACHED_COMMIT_PATTERN.test(head) ? head.toLowerCase() : null };
}

function flatStateFile(stateDir, projectPath) {
  return path.join(stateDir, `${projectSlug(projectPath)}.md`);
}

function branchStateFile(stateDir, projectPath, branch) {
  return path.join(stateDir, projectSlug(projectPath), `${branchStateKey(branch)}.md`);
}

// A detached HEAD gets its own file keyed by the exact commit, never the
// branch's hashed key scheme (irrelevant here, the commit is already a safe
// fixed-length token) and never the legacy flat file, which every detached
// checkout of the project used to share.
function detachedStateFile(stateDir, projectPath, commit) {
  return path.join(stateDir, projectSlug(projectPath), `detached--${commit}.md`);
}

function legacyBranchStateFile(stateDir, projectPath, branch) {
  return path.join(stateDir, projectSlug(projectPath), `${sanitizeBranchName(branch)}.md`);
}

function resolveStateRead(stateDir, projectPath, branch, detachedCommit) {
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

  // A detached HEAD never falls through to the flat file: every detached
  // checkout of the same project used to share that one file, so one
  // worktree's or CI run's state could leak into, or be overwritten by,
  // another's. Each commit gets its own file instead; a different commit
  // never sees it and is reported as 'none', same as a branch with no state
  // yet.
  if (detachedCommit) {
    const detachedFile = detachedStateFile(stateDir, projectPath, detachedCommit);
    return {
      filePath: detachedFile,
      source: fs.existsSync(detachedFile) ? 'detached' : 'none',
      branch: null,
    };
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

function resolveStateWrite(stateDir, projectPath, branch, detachedCommit) {
  if (branch) return branchStateFile(stateDir, projectPath, branch);
  if (detachedCommit) return detachedStateFile(stateDir, projectPath, detachedCommit);
  return flatStateFile(stateDir, projectPath);
}

module.exports = {
  DEFAULT_BRANCH_FILE,
  getStateDir,
  projectSlug,
  sanitizeBranchName,
  branchStateKey,
  detectBranch,
  detectDetachedCommit,
  resolveHeadState,
  trustedGitPath,
  flatStateFile,
  branchStateFile,
  detachedStateFile,
  legacyBranchStateFile,
  resolveStateRead,
  resolveStateWrite,
};
