import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const DEFAULT_BRANCH_FILE = 'main.md';
const BRANCH_FILE_PREFIX_LENGTH = 120;

export type StateSource = 'branch' | 'default-branch' | 'flat' | 'detached' | 'none';

export interface ResolvedState {
  filePath: string;
  source: StateSource;
  branch: string | null;
}

export function projectSlug(projectPath: string): string {
  const parts = projectPath.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.slice(-2).join('--').replace(/[^a-zA-Z0-9-_]/g, '_') || 'default';
}

export function sanitizeBranchName(branch: string): string {
  return branch.replaceAll('/', '-').replace(/[^a-zA-Z0-9-_]/g, '_');
}

// Sanitization alone is not injective: feature/auth and feature-auth both
// become feature-auth. Keep a readable prefix, then bind it to the exact ref.
export function branchStateKey(branch: string): string {
  const branchName = String(branch || '');
  const readablePrefix = sanitizeBranchName(branchName).slice(0, BRANCH_FILE_PREFIX_LENGTH) || 'branch';
  const digest = createHash('sha256').update(branchName, 'utf8').digest('hex');
  return `${readablePrefix}--${digest}`;
}

// Branch detection reads .git/HEAD instead of spawning git: no PATH
// lookup and it works on machines without git installed.
function findGitDir(startPath: string): string | null {
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
// submodule pointer files. Shared by detectBranch and detectDetachedCommit
// so both agree on exactly what HEAD says.
function readHeadLine(projectPath: string): string | null {
  try {
    let gitDir = findGitDir(projectPath);
    if (!gitDir) return null;
    if (fs.statSync(gitDir).isFile()) {
      // Worktrees and submodules store a pointer file instead of a directory
      const pointer = fs.readFileSync(gitDir, 'utf8').trim();
      if (!pointer.startsWith('gitdir:')) return null;
      gitDir = path.resolve(path.dirname(gitDir), pointer.slice('gitdir:'.length).trim());
    }
    return fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  } catch (_) { // NOSONAR: unreadable .git/HEAD means no branch info
    return null;
  }
}

export function detectBranch(projectPath: string): string | null {
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
// outside a git repo, or its content does not look like a commit hash (a
// corrupted .git/HEAD is treated as no detached state, never used as a path
// component).
export function detectDetachedCommit(projectPath: string): string | null {
  const head = readHeadLine(projectPath);
  if (!head || head.startsWith('ref: refs/heads/')) return null;
  return DETACHED_COMMIT_PATTERN.test(head) ? head.toLowerCase() : null;
}

export interface HeadState {
  branch: string | null;
  detachedCommit: string | null;
}

// detectBranch and detectDetachedCommit each read HEAD; pairing them by
// hand at every call site is the exact two-line dance that broke once
// already (scripts/lib/session-context-loader.js kept only half of it).
// Every resolveStateRead/resolveStateWrite call site should get both from
// here instead.
export function resolveHeadState(projectPath: string): HeadState {
  const head = readHeadLine(projectPath);
  if (!head) return { branch: null, detachedCommit: null };
  const refPrefix = 'ref: refs/heads/';
  if (head.startsWith(refPrefix)) {
    return { branch: head.slice(refPrefix.length) || null, detachedCommit: null };
  }
  return { branch: null, detachedCommit: DETACHED_COMMIT_PATTERN.test(head) ? head.toLowerCase() : null };
}

export function flatStateFile(stateDir: string, projectPath: string): string {
  return path.join(stateDir, `${projectSlug(projectPath)}.md`);
}

export function branchStateFile(stateDir: string, projectPath: string, branch: string): string {
  return path.join(stateDir, projectSlug(projectPath), `${branchStateKey(branch)}.md`);
}

// A detached HEAD gets its own file keyed by the exact commit, never the
// legacy flat file every detached checkout of the project used to share.
export function detachedStateFile(stateDir: string, projectPath: string, commit: string): string {
  return path.join(stateDir, projectSlug(projectPath), `detached--${commit}.md`);
}

export function legacyBranchStateFile(stateDir: string, projectPath: string, branch: string): string {
  return path.join(stateDir, projectSlug(projectPath), `${sanitizeBranchName(branch)}.md`);
}

export function resolveStateRead(
  stateDir: string,
  projectPath: string,
  branch: string | null,
  detachedCommit: string | null = null
): ResolvedState {
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
  // never sees it and is reported as 'none', same as a branch with no
  // state yet.
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

export function resolveStateWrite(
  stateDir: string,
  projectPath: string,
  branch: string | null,
  detachedCommit: string | null = null
): string {
  if (branch) return branchStateFile(stateDir, projectPath, branch);
  if (detachedCommit) return detachedStateFile(stateDir, projectPath, detachedCommit);
  return flatStateFile(stateDir, projectPath);
}
