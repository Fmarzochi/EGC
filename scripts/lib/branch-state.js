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

// The directories that hold the system, where no checkout of a person lives:
// a .git under one of them is never read on the account of a project or of a
// pointer. The home and the temp directory come first, as a project under the
// home is accepted by the memory server before a system directory is refused,
// so the home of the root user stays usable. The same roots the server
// refuses as a project path.
const POSIX_SYSTEM_ROOTS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/proc', '/sys', '/dev', '/root', '/var/lib', '/var/log', '/var/run', '/run'];

function systemRoots() {
  if (process.platform !== 'win32') return POSIX_SYSTEM_ROOTS;
  const env = process.env;
  return [
    env.SystemRoot || String.raw`C:\Windows`,
    env.ProgramFiles || String.raw`C:\Program Files`,
    env['ProgramFiles(x86)'] || String.raw`C:\Program Files (x86)`,
    env.ProgramData || String.raw`C:\ProgramData`,
  ];
}

// Windows ignores the case of a path; the comparison does the same there.
function foldCase(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function underSystemRoot(canonical) {
  return systemRoots().some(root => foldCase(canonical).startsWith(foldCase(trustedRoot(root))));
}

function isFilesystemRoot(dir) {
  return path.dirname(dir) === dir;
}

// The canonical absolute form of a git path when it may be read, null
// otherwise. A path under the home directory or the temp directory (untainted
// system values) is trusted as it always was; a path elsewhere only through
// the trust the caller states: `project`, the project the read serves, whose
// own repository (the directory holding .git being the project or one of its
// ancestors) is trusted wherever the checkout lives, never under a system
// directory and never at the filesystem root; `followed`, a path reached from
// a git directory already trusted (a file under it, or the directory a
// worktree pointer or a commondir names, followed once), trusted anywhere
// outside a system directory and off the filesystem root: the pointer is in
// the person's own checkout and git itself follows it, the reads stay HEAD,
// commondir and config, and a link on the way is still refused, a deliberate
// widening since the common directory of a worktree is in another repository
// root than the checkout. So a path handed in by a hook payload or a CLI argument never
// reaches the filesystem unchecked, and a traversal or a link leading to an
// unrelated location is refused before any read. The value returned is what
// every read below uses.
function trustedGitPath(p, trust = {}) {
  const canonical = canonicalPath(p);
  if (!canonical) return null;
  const segments = canonical.split(path.sep);
  const gitAt = segments.indexOf('.git');
  if (gitAt === -1) return null;
  if (canonical.startsWith(trustedRoot(os.homedir())) || canonical.startsWith(trustedRoot(os.tmpdir()))) return canonical;
  if (underSystemRoot(canonical)) return null;
  // The directory that holds .git: the root of the repository the path
  // belongs to. The filesystem root holds no repository of a person.
  const repoRoot = segments.slice(0, gitAt).join(path.sep) || path.sep;
  if (isFilesystemRoot(repoRoot)) return null;
  if (trust.followed) return canonical;
  if (!trust.project) return null;
  // The repository must hold the project too.
  const project = canonicalPath(trust.project);
  if (!project) return null;
  return project === repoRoot || project.startsWith(withTrailingSeparator(repoRoot)) ? canonical : null;
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

const NOFOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
const NONBLOCK_FLAG = typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0;

// Opens the exact path handed in, refusing a symlinked final component
// (O_NOFOLLOW) instead of resolving it first and reading the target: a
// resolve-then-read sequence leaves a TOCTOU window where the link can be
// swapped between the two steps to redirect the read outside the trusted
// roots trustedGitPath already approved. O_NONBLOCK keeps a FIFO planted at
// the path from blocking this call forever.
//
// Windows has no O_NOFOLLOW (NOFOLLOW_FLAG is 0 there), so openSync alone
// would silently follow a symlinked final component. An explicit lstatSync
// right before the open narrows, but on this platform cannot fully close,
// that same TOCTOU window; it is still strictly better than not checking.
function readFileNoFollow(filePath) {
  let fd;
  try {
    if (NOFOLLOW_FLAG === 0 && fs.lstatSync(filePath).isSymbolicLink()) return null;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG);
    if (!fs.fstatSync(fd).isFile()) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// True when the path is currently a symlink. NOSONAR: the path was already
// confirmed by the trustedGitPath guard at every call site below; this only
// reads metadata (never file content) off that same path, but Sonar's taint
// tracker does not credit a guard that checks a sanitizer's return value
// without reassigning it back to the variable -- the identical pattern in
// branch-state.ts's readHeadLine does not trigger this. Reassigning the
// variable to the canonicalized path instead would reopen the exact TOCTOU
// this module exists to close (see the comment above readFileNoFollow).
function isUnsafeSymlink(p) {
  return fs.lstatSync(p).isSymbolicLink(); // NOSONAR
}

// Reads the raw, trimmed content of .git/HEAD, resolving worktree and
// submodule pointer files and refusing anything the project may not read.
// Shared by detectBranch and detectDetachedCommit so both agree on exactly
// what HEAD says.
//
// trustedGitPath is used only as a yes/no check here; every read opens the
// original, unresolved path with O_NOFOLLOW, which refuses a symlinked
// final component outright, including one pointing at another trusted .git.
// The isUnsafeSymlink check right before each open is deliberately placed
// with nothing else between it and the open it guards: Node has no portable
// openat() to anchor an open to an already-validated directory fd, so this
// adjacency is the narrowest TOCTOU window achievable without a native
// binding, not a hermetic close of it. Closing it fully would require an
// attacker-proof primitive this project does not depend on today.
function resolveGitDir(projectPath) {
  let gitDir = findGitDir(projectPath);
  if (!gitDir || !trustedGitPath(gitDir, { project: projectPath }) || isUnsafeSymlink(gitDir)) return null;
  if (fs.statSync(gitDir).isFile()) { // NOSONAR: metadata read on gitDir, confirmed just above
    // Worktrees and submodules store a pointer file instead of a directory
    const rawPointer = readFileNoFollow(gitDir);
    if (rawPointer === null) return null;
    const pointer = rawPointer.trim();
    if (!pointer.startsWith('gitdir:')) return null;
    gitDir = path.resolve(path.dirname(gitDir), pointer.slice('gitdir:'.length).trim());
    if (!trustedGitPath(gitDir, { followed: true }) || isUnsafeSymlink(gitDir)) return null;
  }
  return gitDir;
}

// One small file of a git directory (HEAD, commondir, config), read right
// after the directory itself is confirmed not to be a link, never through
// one; null otherwise.
function readGitFile(gitDir, name) {
  const filePath = path.resolve(gitDir, name);
  if (!trustedGitPath(filePath, { followed: true }) || isUnsafeSymlink(gitDir)) return null;
  return readFileNoFollow(filePath);
}

function readHeadLine(projectPath) {
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
function resolveCommonDir(gitDir) {
  const commondir = readGitFile(gitDir, 'commondir');
  if (commondir === null) return gitDir;
  const common = path.resolve(gitDir, commondir.trim());
  return trustedGitPath(common, { followed: true }) && !isUnsafeSymlink(common) ? common : null;
}

const CONFIG_ESCAPES = { n: '\n', t: '\t', b: '\b' };

// The value of a config assignment as git reads it: quotes may open and
// close anywhere and are dropped, a backslash escapes the next character
// (\n, \t and \b as git does, anything else literally), and # or ; outside
// quotes starts a comment. A scan rather than a pattern, so a hostile line
// cannot make the parser backtrack.
function configValue(raw) {
  let out = '';
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '\\') {
      index += 1;
      if (index < raw.length) out += CONFIG_ESCAPES[raw[index]] ?? raw[index];
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (char === '#' || char === ';')) break;
    out += char;
  }
  return out.trim();
}

// The index of the bracket that closes a section header, outside quotes
// and escapes; -1 when the line has none.
function closingBracket(line) {
  let quoted = false;
  for (let index = 1; index < line.length; index += 1) {
    const char = line[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ']' && !quoted) {
      return index;
    }
  }
  return -1;
}

// A subsection name between quotes: a backslash escapes the next character
// and is dropped, as git reads it.
function unescapeSubsection(text) {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\\' && index + 1 < text.length) index += 1;
    out += text[index];
  }
  return out;
}

// The section a config header line opens: [name], [name "subsection"] or
// the deprecated [name.subsection], whose subsection compares
// case-insensitively; the name is lower-cased as git compares it. `rest` is
// what follows the closing bracket on the same line, which git reads as an
// assignment or a comment. Null for any other line.
function configSection(line) {
  if (!line.startsWith('[')) return null;
  const close = closingBracket(line);
  if (close < 0) return null;
  const inner = line.slice(1, close);
  const rest = line.slice(close + 1).trim();
  const quote = inner.indexOf('"');
  if (quote >= 0) {
    const lastQuote = inner.lastIndexOf('"');
    if (lastQuote === quote) return null;
    return { name: inner.slice(0, quote).trim().toLowerCase(), subsection: unescapeSubsection(inner.slice(quote + 1, lastQuote)), rest };
  }
  const dot = inner.indexOf('.');
  if (dot >= 0) return { name: inner.slice(0, dot).trim().toLowerCase(), subsection: inner.slice(dot + 1).trim().toLowerCase(), rest };
  return { name: inner.trim().toLowerCase(), subsection: null, rest };
}

// The value a config line gives to `key`, or null when the line sets
// another key or is not an assignment.
function configEntry(line, key) {
  if (line.slice(0, key.length).toLowerCase() !== key) return null;
  const rest = line.slice(key.length).trimStart();
  return rest.startsWith('=') ? configValue(rest.slice(1)) : null;
}

// Whether a comment starts on the line, outside quotes and escapes: git
// reads a comment to the end of its line, a trailing backslash included.
function hasComment(line) {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === '#' || char === ';')) {
      return true;
    }
  }
  return false;
}

// The lines of a config as git reads them: a line that ends with an odd
// number of backslashes continues on the next one, unless a comment started
// on it.
function configLines(config) {
  const lines = [];
  let pending = '';
  for (const line of config.split(/\r?\n/)) {
    let backslashes = 0;
    while (backslashes < line.length && line[line.length - 1 - backslashes] === '\\') backslashes += 1;
    if (backslashes % 2 === 1 && !hasComment(pending + line)) {
      pending += line.slice(0, -1);
      continue;
    }
    lines.push(pending + line);
    pending = '';
  }
  if (pending) lines.push(pending);
  return lines;
}

function isConfigComment(line) {
  return !line || line.startsWith('#') || line.startsWith(';');
}

// The first url of [remote "origin"] in the text of a git config, read as
// git reads it; include directives are not followed, so an origin declared
// only in an included file is not seen, and the project then keeps its
// path slug.
function originUrlFromConfig(config) {
  let inOrigin = false;
  for (const rawLine of configLines(config)) {
    let line = rawLine.trim();
    if (isConfigComment(line)) continue;
    // Git reads any number of headers on one line, then an assignment.
    for (let section = configSection(line); section; section = configSection(line)) {
      inOrigin = section.name === 'remote' && section.subsection === 'origin';
      line = section.rest;
    }
    if (isConfigComment(line) || !inOrigin) continue;
    const url = configEntry(line, 'url');
    if (url) return url;
  }
  return null;
}

// The url of the origin remote as the config of the repository states it,
// or null outside a repository, without an origin or when the config cannot
// be read. Read from the config file, like HEAD: no git on PATH is needed.
function detectOriginRemote(projectPath) {
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

// The port a scheme uses when the URL names none; a port equal to it is not
// part of the identity, as the WHATWG URL parser already does for http.
const DEFAULT_PORTS = { 'ssh:': '22', 'git+ssh:': '22', 'ssh+git:': '22', 'git:': '9418' };

function trimTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function trimLeadingSlashes(value) {
  let start = 0;
  while (start < value.length && value[start] === '/') start += 1;
  return value.slice(start);
}

function withoutRepositorySuffix(location) {
  const out = trimTrailingSlashes(location.replaceAll('\\', '/'));
  return out.toLowerCase().endsWith('.git') ? trimTrailingSlashes(out.slice(0, -4)) : out;
}

// A drive letter is one letter whatever its case; the rest of a local path
// is kept as written.
function withUpperDrive(location) {
  return /^[a-zA-Z]:\//.test(location) ? location[0].toUpperCase() + location.slice(1) : location;
}

// A path on this machine names a repository only here, so its identity is
// local: file/ and the path, in the same shape on every platform.
function localIdentity(location) {
  const stripped = withUpperDrive(trimLeadingSlashes(withoutRepositorySuffix(location)));
  return stripped ? `file/${stripped}` : null;
}

function hostIdentity(host, rawPath) {
  const repositoryPath = trimLeadingSlashes(withoutRepositorySuffix(rawPath));
  return host && repositoryPath ? `${host}/${repositoryPath}` : null;
}

// The scheme of a URL when the value has one (scheme://...): a letter, then
// letters, digits, plus, dot or hyphen, as RFC 3986 allows; null otherwise.
function urlScheme(value) {
  const end = value.indexOf('://');
  if (end <= 0) return null;
  const scheme = value.slice(0, end);
  return /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme) ? scheme : null;
}

// A bracketed host of the scp-like form: [host] is the host, [host:port] is
// the host and port of the ssh URL (the default port dropped as there), and
// an IPv6 address keeps its brackets, as the URL form does.
function unbracketedHost(host) {
  if (!host.startsWith('[') || !host.endsWith(']')) return host;
  const inner = host.slice(1, -1);
  const parts = inner.split(':');
  if (parts.length === 1) return inner;
  if (parts.length === 2) return parts[1] === DEFAULT_PORTS['ssh:'] ? parts[0] : inner;
  return host;
}

// The host and the path of the scp-like form git accepts (user@host:path,
// with an IPv6 address or a host and port between brackets): the first
// colon after the host splits them, the host starts after the last @ before
// it, and nothing before it may be a slash.
function scpLikeParts(value) {
  const firstColon = value.indexOf(':');
  if (firstColon <= 0) return null;
  const at = value.lastIndexOf('@', firstColon);
  const hostStart = at >= 0 ? at + 1 : 0;
  let colon = firstColon;
  if (value[hostStart] === '[') {
    const close = value.indexOf(']', hostStart);
    if (close < 0 || value[close + 1] !== ':') return null;
    colon = close + 1;
  }
  const authority = value.slice(0, colon);
  if (authority.includes('/') || authority.includes('\\')) return null;
  const host = unbracketedHost(authority.slice(hostStart));
  return host ? { host, path: value.slice(colon + 1) } : null;
}

function decodedPath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

// The normalized form of a remote URL, the identity of a repository across
// machines: the host in lower case (with its port only when it is not the
// default of the scheme), then the path without a leading slash, a trailing
// slash or the .git suffix; the scheme and the credentials are dropped,
// owner and name are kept as written. Every form git accepts for one
// repository (https, ssh URL, scp-like) folds into one string; a local path
// folds into a local identity, a relative one resolved against `baseDir`,
// the checkout that names it, when one is given. The scp-like path without
// a leading slash and the one with it fold together too, as the hosting
// services treat them. Null when the value names no repository.
function normalizeRemoteUrl(url, baseDir) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return localIdentity(trimmed);
  if (urlScheme(trimmed)) {
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol === 'file:') return localIdentity(`${parsed.hostname}${decodedPath(parsed.pathname)}`);
    const defaultPort = DEFAULT_PORTS[parsed.protocol] ?? '';
    const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : '';
    return hostIdentity(parsed.hostname.toLowerCase() + port, decodedPath(parsed.pathname));
  }
  const scpLike = scpLikeParts(trimmed);
  if (scpLike) return hostIdentity(scpLike.host.toLowerCase(), scpLike.path);
  // A UNC path is absolute on every platform, whatever path.isAbsolute says
  // of it on POSIX.
  const isAbsoluteLocal = path.isAbsolute(trimmed) || trimmed.startsWith('\\\\') || trimmed.startsWith('//');
  return localIdentity(baseDir && !isAbsoluteLocal ? path.resolve(baseDir, trimmed) : trimmed);
}

// The directory name of a project keyed by its remote: the name of the
// repository, readable, bound to the SHA-256 of the whole identity, the same
// shape as a branch file. Neither the host nor the owner nor any local path
// is in it, so the shared repository of a team shows none of them.
function remoteKey(identity) {
  const name = identity.slice(identity.lastIndexOf('/') + 1) || 'repo';
  const readable = name.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, BRANCH_FILE_PREFIX_LENGTH) || 'repo';
  return `${readable}--${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

// What names a project on every machine: its origin remote when the
// checkout has one, so the same repository under different paths on two
// machines is one project; the slug of the path otherwise, as before.
// The root of the checkout, where git resolves a relative remote: the
// directory that holds .git, in its canonical form, so a call from a
// subdirectory of the checkout, or through a link to it, yields the same
// identity; the path itself outside a repository.
function repositoryRoot(projectPath) {
  const gitDir = findGitDir(projectPath);
  const root = gitDir ? path.dirname(gitDir) : projectPath;
  try {
    return fs.realpathSync.native(root);
  } catch {
    return root;
  }
}

function projectIdentity(projectPath) {
  const remote = normalizeRemoteUrl(detectOriginRemote(projectPath) || '', repositoryRoot(projectPath));
  if (remote) return { key: remoteKey(remote), kind: 'remote', remote };
  return { key: projectSlug(projectPath), kind: 'path', remote: null };
}

function projectKey(projectPath) {
  return projectIdentity(projectPath).key;
}

// The directories the documents of a project are read from, in order: its
// key and, for a project keyed by its remote, the slug of its path too,
// where the versions before the identity wrote them. A machine upgraded
// from one of them keeps reading them with no manual step; the keyed name
// is tried first at every step, so a document written by this version
// shadows the older one.
function projectReadNames(projectPath) {
  const identity = projectIdentity(projectPath);
  return identity.kind === 'remote' ? [identity.key, projectSlug(projectPath)] : [identity.key];
}

function firstExisting(candidates) {
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

function flatStateFile(stateDir, projectPath) {
  return path.join(stateDir, `${projectKey(projectPath)}.md`);
}

function branchStateFile(stateDir, projectPath, branch) {
  return path.join(stateDir, projectKey(projectPath), `${branchStateKey(branch)}.md`);
}

// A detached HEAD gets its own file keyed by the exact commit, never the
// branch's hashed key scheme (irrelevant here, the commit is already a safe
// fixed-length token) and never the legacy flat file, which every detached
// checkout of the project used to share.
function detachedStateFile(stateDir, projectPath, commit) {
  return path.join(stateDir, projectKey(projectPath), `detached--${commit}.md`);
}

// The file the versions before the hashed branch name wrote: under the slug
// of the path, the only key those versions had.
function legacyBranchStateFile(stateDir, projectPath, branch) {
  return path.join(stateDir, projectSlug(projectPath), `${sanitizeBranchName(branch)}.md`);
}

function resolveStateRead(stateDir, projectPath, branch, detachedCommit) {
  const names = projectReadNames(projectPath);
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
  // never sees it and is reported as 'none', same as a branch with no state
  // yet.
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

function resolveStateWrite(stateDir, projectPath, branch, detachedCommit) {
  if (branch) return branchStateFile(stateDir, projectPath, branch);
  if (detachedCommit) return detachedStateFile(stateDir, projectPath, detachedCommit);
  return flatStateFile(stateDir, projectPath);
}

module.exports = {
  DEFAULT_BRANCH_FILE,
  getStateDir,
  projectSlug,
  normalizeRemoteUrl,
  originUrlFromConfig,
  detectOriginRemote,
  projectIdentity,
  projectKey,
  projectReadNames,
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
