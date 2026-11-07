import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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

// What sits at a path that does not resolve: 'absent' (nothing there, or
// a parent that is not a directory), 'link' (a link, a dangling one
// included: never appended lexically, since a target created or moved
// later would redirect it past the check), or 'unknown' when the path
// cannot be inspected at all, which the caller treats like a link.
function unresolvedComponent(p: string): 'absent' | 'link' | 'plain' | 'unknown' {
  try {
    return fs.lstatSync(p).isSymbolicLink() ? 'link' : 'plain';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown';
  }
}

// The canonical absolute form of a path: links are resolved through the
// nearest existing ancestor and the rest is appended lexically, so a link
// planted at .git or above it cannot lead a read outside the trusted roots
// while the lexical path still looks inside them. A path that cannot be
// canonicalised (a link loop, a dangling link on the way, a parent that
// cannot be inspected) is null.
function canonicalPath(p: string): string | null {
  let existing = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(existing);
      return tail.length > 0 ? path.join(real, ...tail) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }
    const component = unresolvedComponent(existing);
    if (component === 'link' || component === 'unknown') return null;
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
}

function withTrailingSeparator(dir: string): string {
  return dir.endsWith(path.sep) ? dir : dir + path.sep;
}

function trustedRoot(dir: string): string {
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
export function trustedGitPath(p: string): string | null {
  const canonical = canonicalPath(p);
  if (!canonical) return null;
  const underTrustedRoot = canonical.startsWith(trustedRoot(os.homedir())) || canonical.startsWith(trustedRoot(os.tmpdir()));
  const hasGitSegment = canonical.split(path.sep).includes('.git');
  return underTrustedRoot && hasGitSegment ? canonical : null;
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

// O_NOFOLLOW/O_NONBLOCK are POSIX-only (undefined in fs.constants on
// Windows); fall back to a plain blocking open there, where
// trustedGitPath's canonicalization is the only guard. Same discipline as
// readRegularNoFollow in scripts/lib/state-integrity.js.
const NOFOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
const NONBLOCK_FLAG = typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0;

// Reads a small regular file through a descriptor that never followed a
// link, or null. On POSIX this closes most of the gap between
// trustedGitPath validating a path and a later read re-walking it: the open
// itself refuses a final component that is a symlink, so a link planted
// there after validation cannot be followed. O_NONBLOCK plus the fstat
// isFile() check also refuse a FIFO or device planted at the path, which
// would otherwise block openSync synchronously until a writer appears,
// freezing the server's event loop on the next get_state/update_state.
function readFileNoFollow(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG);
    if (!fs.fstatSync(fd).isFile()) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The git directory of a project: the nearest .git under a trusted root,
// never a link, with a worktree or submodule pointer file followed once and
// checked the same way. trustedGitPath canonicalizes (follows symlinks) to
// decide whether a path is trustworthy, so its return value is the resolved
// target, not the path that was asked about; using that value to open a
// file would read straight through a symlink planted at gitDir or HEAD to
// whatever trusted-looking target it leads to. It is used here only as a
// yes/no check: every read opens the original, unresolved path with
// O_NOFOLLOW, which refuses a symlinked final component outright, including
// one pointing at another trusted .git.
function resolveGitDir(projectPath: string): string | null {
  let gitDir = findGitDir(projectPath);
  if (!gitDir || !trustedGitPath(gitDir)) return null;
  // Narrows the directory-component case too, though only for gitDir
  // itself: a link here never reaches the opens below (gitDir is only
  // used to build the paths read, each independently O_NOFOLLOW
  // protected), so this is a second, cheap layer, not the only one.
  if (fs.lstatSync(gitDir).isSymbolicLink()) return null;
  if (fs.statSync(gitDir).isFile()) {
    // Worktrees and submodules store a pointer file instead of a directory
    const rawPointer = readFileNoFollow(gitDir);
    if (rawPointer === null) return null;
    const pointer = rawPointer.trim();
    if (!pointer.startsWith('gitdir:')) return null;
    gitDir = path.resolve(path.dirname(gitDir), pointer.slice('gitdir:'.length).trim());
    if (!trustedGitPath(gitDir)) return null;
  }
  return gitDir;
}

// One small file of a git directory (HEAD, commondir, config), read only
// when its path is trusted and never through a link; null otherwise.
function readGitFile(gitDir: string, name: string): string | null {
  const filePath = path.resolve(gitDir, name);
  if (!trustedGitPath(filePath)) return null;
  return readFileNoFollow(filePath);
}

// Reads the raw, trimmed content of .git/HEAD, resolving worktree and
// submodule pointer files and refusing anything outside the trusted roots.
// Shared by detectBranch and detectDetachedCommit so both agree on exactly
// what HEAD says.
function readHeadLine(projectPath: string): string | null {
  try {
    const gitDir = resolveGitDir(projectPath);
    if (!gitDir) return null;
    const head = readGitFile(gitDir, 'HEAD');
    return head === null ? null : head.trim();
  } catch (_) { // NOSONAR: unreadable .git/HEAD means no branch info available
    return null;
  }
}

// The directory that holds the config of the repository: the git directory
// itself, or the common directory a worktree names in its commondir file.
function resolveCommonDir(gitDir: string): string | null {
  const commondir = readGitFile(gitDir, 'commondir');
  if (commondir === null) return gitDir;
  const common = path.resolve(gitDir, commondir.trim());
  return trustedGitPath(common) ? common : null;
}

// The text of a quoted config value, read up to its closing quote with the
// escapes resolved. A scan rather than a pattern: a hostile config line
// must not make the parser backtrack.
function unquoteConfigValue(value: string): string {
  let out = '';
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') break;
    if (char === '\\' && index + 1 < value.length) {
      index += 1;
      out += value[index];
      continue;
    }
    out += char;
  }
  return out;
}

// A bare config value up to the comment that may follow it.
function withoutConfigComment(value: string): string {
  let end = value.length;
  for (const marker of ['#', ';']) {
    const index = value.indexOf(marker);
    if (index >= 0 && index < end) end = index;
  }
  return value.slice(0, end).trim();
}

// A config value as git reads it: a quoted value whole, a bare value up to
// its comment.
function configValue(raw: string): string {
  const value = raw.trim();
  return value.startsWith('"') ? unquoteConfigValue(value) : withoutConfigComment(value);
}

interface ConfigSection {
  name: string;
  subsection: string | null;
}

// The section a config header line opens, [name] or [name "subsection"],
// with the name lower-cased as git compares it; null for any other line.
function configSection(line: string): ConfigSection | null {
  if (!line.startsWith('[') || !line.endsWith(']')) return null;
  const inner = line.slice(1, -1).trim();
  const space = inner.search(/\s/);
  if (space < 0) return { name: inner.toLowerCase(), subsection: null };
  const rest = inner.slice(space).trim();
  if (rest.length < 2 || !rest.startsWith('"') || !rest.endsWith('"')) return null;
  return { name: inner.slice(0, space).toLowerCase(), subsection: unquoteConfigValue(rest) };
}

// The value a config line gives to `key`, or null when the line sets
// another key or is not an assignment.
function configEntry(line: string, key: string): string | null {
  if (line.slice(0, key.length).toLowerCase() !== key) return null;
  const rest = line.slice(key.length).trimStart();
  return rest.startsWith('=') ? configValue(rest.slice(1)) : null;
}

// The first url of [remote "origin"] in the text of a git config. Section
// names compare case-insensitively and the subsection as written, as git
// does; include directives are not followed, so an origin declared only in
// an included file is not seen, and the project then keeps its path slug.
export function originUrlFromConfig(config: string): string | null {
  let inOrigin = false;
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = configSection(line);
    if (section) {
      inOrigin = section.name === 'remote' && section.subsection === 'origin';
      continue;
    }
    if (!inOrigin) continue;
    const url = configEntry(line, 'url');
    if (url) return url;
  }
  return null;
}

// The url of the origin remote as the config of the repository states it,
// or null outside a repository, without an origin or when the config cannot
// be read. Read from the config file, like HEAD: no git on PATH is needed.
export function detectOriginRemote(projectPath: string): string | null {
  try {
    const gitDir = resolveGitDir(projectPath);
    if (!gitDir) return null;
    const commonDir = resolveCommonDir(gitDir);
    if (!commonDir) return null;
    const config = readGitFile(commonDir, 'config');
    return config === null ? null : originUrlFromConfig(config);
  } catch {
    // A repository that cannot be inspected (gone mid-read, a sealed
    // directory, a link loop) has no remote identity: the project keeps
    // the slug of its path, as it would without a repository.
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

export type ProjectIdentityKind = 'remote' | 'path';

export interface ProjectIdentity {
  key: string;
  kind: ProjectIdentityKind;
  remote: string | null;
}

const DEFAULT_SSH_PORT = '22';

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function trimLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value[start] === '/') start += 1;
  return value.slice(start);
}

function withoutRepositorySuffix(location: string): string {
  const out = trimTrailingSlashes(location.replaceAll('\\', '/'));
  return out.toLowerCase().endsWith('.git') ? trimTrailingSlashes(out.slice(0, -4)) : out;
}

// A path on this machine names a repository only here, so its identity is
// local: file/ and the path, in the same shape on every platform.
function localIdentity(location: string): string | null {
  const stripped = trimLeadingSlashes(withoutRepositorySuffix(location));
  return stripped ? `file/${stripped}` : null;
}

function hostIdentity(host: string, rawPath: string): string | null {
  const repositoryPath = trimLeadingSlashes(withoutRepositorySuffix(rawPath));
  return host && repositoryPath ? `${host}/${repositoryPath}` : null;
}

// The scheme of a URL when the value has one (scheme://...): a letter, then
// letters, digits, plus, dot or hyphen, as RFC 3986 allows; null otherwise.
function urlScheme(value: string): string | null {
  const end = value.indexOf('://');
  if (end <= 0) return null;
  const scheme = value.slice(0, end);
  return /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme) ? scheme : null;
}

interface ScpLikeParts {
  host: string;
  path: string;
}

// The host and the path of the scp-like form git accepts (user@host:path):
// the first colon splits them, and nothing before it may be a slash.
function scpLikeParts(value: string): ScpLikeParts | null {
  const colon = value.indexOf(':');
  if (colon <= 0) return null;
  const authority = value.slice(0, colon);
  if (authority.includes('/') || authority.includes('\\')) return null;
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  return host ? { host, path: value.slice(colon + 1) } : null;
}

function decodedPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

// The normalized form of a remote URL, the identity of a repository across
// machines: the host in lower case (with its port only when it is not the
// default of ssh), then the path without a leading slash, a trailing slash
// or the .git suffix; the scheme and the credentials are dropped, owner and
// name are kept as written. Every form git accepts for one repository
// (https, ssh URL, scp-like) folds into one string; a local path folds into
// a local identity. Null when the value names no repository.
export function normalizeRemoteUrl(url: string): string | null {
  const trimmed = String(url || '').trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return localIdentity(trimmed);
  if (urlScheme(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol === 'file:') return localIdentity(decodedPath(parsed.pathname));
    const isSsh = parsed.protocol.includes('ssh');
    const port = parsed.port && !(isSsh && parsed.port === DEFAULT_SSH_PORT) ? `:${parsed.port}` : '';
    return hostIdentity(parsed.hostname.toLowerCase() + port, decodedPath(parsed.pathname));
  }
  const scpLike = scpLikeParts(trimmed);
  if (scpLike) return hostIdentity(scpLike.host.toLowerCase(), scpLike.path);
  return localIdentity(trimmed);
}

// The directory name of a project keyed by its remote: the name of the
// repository, readable, bound to the SHA-256 of the whole identity, the same
// shape as a branch file. Neither the host nor the owner nor any local path
// is in it, so the shared repository of a team shows none of them.
function remoteKey(identity: string): string {
  const segments = identity.split('/').filter(Boolean);
  const name = segments[segments.length - 1] || 'repo';
  const readable = name.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, BRANCH_FILE_PREFIX_LENGTH) || 'repo';
  return `${readable}--${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

// What names a project on every machine: its origin remote when the
// checkout has one, so the same repository under different paths on two
// machines is one project; the slug of the path otherwise, as before.
export function projectIdentity(projectPath: string): ProjectIdentity {
  const remote = normalizeRemoteUrl(detectOriginRemote(projectPath) || '');
  if (remote) return { key: remoteKey(remote), kind: 'remote', remote };
  return { key: projectSlug(projectPath), kind: 'path', remote: null };
}

export function projectKey(projectPath: string): string {
  return projectIdentity(projectPath).key;
}

// The directories the documents of a project are read from: its key and,
// for a project keyed by its remote, the slug of its path too, where the
// versions before the identity wrote them. A machine upgraded from one of
// them keeps reading them with no manual step; the keyed name is tried
// first at every step, so a document written by this version shadows the
// older one.
function projectDirNames(projectPath: string): string[] {
  const identity = projectIdentity(projectPath);
  return identity.kind === 'remote' ? [identity.key, projectSlug(projectPath)] : [identity.key];
}

function firstExisting(candidates: readonly string[]): string | null {
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

export function flatStateFile(stateDir: string, projectPath: string): string {
  return path.join(stateDir, `${projectKey(projectPath)}.md`);
}

export function branchStateFile(stateDir: string, projectPath: string, branch: string): string {
  return path.join(stateDir, projectKey(projectPath), `${branchStateKey(branch)}.md`);
}

// A detached HEAD gets its own file keyed by the exact commit, never the
// legacy flat file every detached checkout of the project used to share.
export function detachedStateFile(stateDir: string, projectPath: string, commit: string): string {
  return path.join(stateDir, projectKey(projectPath), `detached--${commit}.md`);
}

export function legacyBranchStateFile(stateDir: string, projectPath: string, branch: string): string {
  return path.join(stateDir, projectKey(projectPath), `${sanitizeBranchName(branch)}.md`);
}

export function resolveStateRead(
  stateDir: string,
  projectPath: string,
  branch: string | null,
  detachedCommit: string | null = null
): ResolvedState {
  const names = projectDirNames(projectPath);
  if (branch) {
    const own = firstExisting(names.flatMap(name => [
      path.join(stateDir, name, `${branchStateKey(branch)}.md`),
      path.join(stateDir, name, `${sanitizeBranchName(branch)}.md`),
    ]));
    if (own) return { filePath: own, source: 'branch', branch };
    // Current versions write the default branch under its hashed key, so the
    // fallback must look there first; the plain main.md name is only left
    // behind by pre-hash versions and would otherwise shadow newer state.
    const fallback = firstExisting(names.flatMap(name => [
      path.join(stateDir, name, `${branchStateKey('main')}.md`),
      path.join(stateDir, name, DEFAULT_BRANCH_FILE),
    ]));
    if (fallback) return { filePath: fallback, source: 'default-branch', branch };
  }

  // A detached HEAD never falls through to the flat file: every detached
  // checkout of the same project used to share that one file, so one
  // worktree's or CI run's state could leak into, or be overwritten by,
  // another's. Each commit gets its own file instead; a different commit
  // never sees it and is reported as 'none', same as a branch with no
  // state yet.
  if (detachedCommit) {
    const candidates = names.map(name => path.join(stateDir, name, `detached--${detachedCommit}.md`));
    const detached = firstExisting(candidates);
    return {
      filePath: detached ?? candidates[0],
      source: detached ? 'detached' : 'none',
      branch: null,
    };
  }

  const flats = names.map(name => path.join(stateDir, `${name}.md`));
  const flat = firstExisting(flats);
  if (flat) return { filePath: flat, source: 'flat', branch: branch || null };

  return {
    filePath: branch ? path.join(stateDir, names[0], `${branchStateKey(branch)}.md`) : flats[0],
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
