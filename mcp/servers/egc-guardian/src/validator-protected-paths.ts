import os from 'node:os';
import path from 'node:path';
import { foldCase, expandHome, resolveRealOrLexical } from './validator-path-utils.js';
import { isGitControlFile, isConfiguredHook, isRegularFile, isToolHookSurface } from './validator-hook-surfaces.js';

// Protected file patterns (checked on full path string).
//
// AI coding tool home directories (~/.claude, ~/.cursor, ~/.gemini, ~/.config/*)
// mix real credential files with functional data the tool's own assistant
// legitimately writes (skills, agents, native memory, user-requested config
// edits). Blocking the whole directory breaks that functional data for no
// security gain, since the actual secret is always one specific file, not
// the directory. Deny the credential file by pattern instead. Sources: each
// tool's official docs, verified 2026-07-11 (see docs/architecture or the
// PR that introduced this comment for the full per-tool research).
// The disk and memory devices under /dev, listed at the end.
const DEVICE_DIR = String.raw`^(?:[a-z]:)?[\\/]dev[\\/]`;
const NUMBERED_DEVICES = ['nvme', 'mmcblk', 'dm-', 'md', 'loop', 'sr', 'nbd', 'zram', 'fd', 'ram', 'rbd', 'pmem', 'mtdblock', 'mtd', 'sg', 'disk', 'rdisk'];
export const PROTECTED_FILE_PATTERNS: RegExp[] = [
  // EGC install-state: egc repair and uninstall replay what it records, so a
  // planted entry would turn either into a write or delete of its choosing.
  /(^|[\\/])egc[\\/][\w-]*install-state\.json$/,
  /(^|[\\/])egc-install-state\.json$/,
  /\.env$/,
  // .env.example/.sample/.template are conventionally committed templates
  // with placeholder values, never real secrets — excluded so they're
  // readable/writable like any other file. .env.local/.production/.staging
  // and everything else still match (real per-environment secret files).
  /\.env\.(?!example$|sample$|template$)/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.npmrc$/,
  /\.pypirc$/,
  // Claude Code: OAuth session lives in .credentials.json inside ~/.claude,
  // and in ~/.claude.json at the home root (sibling of ~/.claude, not inside
  // it). settings.json, skills, agents, and projects/*/memory/ are functional.
  /\.claude[\\/]\.credentials\.json$/,
  /(^|[\\/])\.claude\.json$/,
  // Antigravity, on the ~/.gemini root the retired Gemini CLI used to share.
  // GEMINI.md, config/, skills/ and antigravity-cli/ (native memory) are functional.
  /\.gemini[\\/]oauth_creds\.json$/,
  /\.gemini[\\/]google_accounts\.json$/,
  /\.gemini[\\/].*mcp-oauth-tokens\.json$/,
  /\.gemini[\\/]a2a-oauth-tokens\.json$/,
  // Antigravity's shared MCP server registration file, read by the CLI, the
  // IDE and Antigravity 2.0 (scripts/lib/mcp-register.js's "Antigravity"
  // target). guardian-bin.js's fromMcpConfigs() trusts this file the same
  // way it trusts ~/.claude.json, to resolve the guardian CLI for an
  // Antigravity-only install; that trust is only sound if a write here is
  // denied, or a prompt-injected agent could repoint egc-guardian's own MCP
  // entry at an arbitrary script and have this validator treat it as
  // authoritative.
  /\.gemini[\\/]config[\\/]mcp_config\.json$/,
  // The Antigravity CLI's pre-migration registration file (scripts/lib/
  // mcp-register.js's "Antigravity CLI (pre-migration path)" target). Internal
  // audit (EGC-460/461, 2026-07-27) found guardian-bin.js now also trusts
  // this file, for the same reasoning as the shared entry above.
  /\.gemini[\\/]antigravity-cli[\\/]mcp_config\.json$/,
  // OpenCode's real MCP server registration file (scripts/lib/
  // mcp-register.js's "OpenCode" target); same reasoning and same audit.
  /\.config[\\/]opencode[\\/]config\.json$/,
  // Codex CLI: OAuth/API key auth file.
  /\.codex[\\/]auth\.json$/,
  // Codex CLI's real MCP server registration file (scripts/lib/
  // mcp-register.js's registerToml(), TOML not JSON). guardian-bin.js's
  // fromCodexToml() now trusts this file the same way fromMcpConfigs()
  // trusts the JSON configs above, to resolve the guardian CLI for a
  // Codex-only install: same reasoning, same audit (2026-07-27). A write
  // here must be denied, or a prompt-injected agent could repoint
  // egc-guardian's own MCP entry at an arbitrary script and have this
  // validator treat it as authoritative.
  /\.codex[\\/]config\.toml$/,
  // Home-scoped install marker (scripts/lib/install/apply.js's
  // writeGuardianCliMarker(), 2026-07-27 internal design review EGC-465).
  // guardian-bin.js's fromEgcHomeMarker() trusts this file's packageRoot
  // value to resolve the guardian CLI on installs with no MCP config of
  // their own (Copilot, CodeBuddy). Same reasoning as the other resolution
  // sources above: a write here must be denied, or a prompt-injected agent
  // could point resolution at an arbitrary script.
  /\.egc[\\/]guardian-cli-path\.json$/,
  // Amp: OAuth tokens live under this subfolder; config is elsewhere.
  /\.amp[\\/]oauth([\\/]|$)/,
  // Kiro: the CLI's token cache lives outside ~/.kiro, under XDG data dir.
  /\.local[\\/]share[\\/]kiro-cli[\\/]data\.sqlite3$/,
  // Continue.dev: not yet an EGC install target, but its real secret file is
  // .env (already caught by the generic pattern above) plus these two
  // environment dotfiles. config.yaml, prompts/, sessions/, and index/ are
  // functional and must stay writable once Continue.dev is integrated.
  /\.continue[\\/]\.local$/,
  /\.continue[\\/]\.staging$/,
  // Shell startup files and git config: not credential stores, but a
  // write here is a persistence mechanism — code planted here runs on
  // every new shell (rc files) or every git invocation that hits an
  // aliased subcommand (gitconfig aliases can run arbitrary shell via
  // `alias.x = "!sh -c ..."`), long after the current session ends.
  /(^|[\\/])\.bashrc$/,
  /(^|[\\/])\.zshrc$/,
  /(^|[\\/])\.bash_profile$/,
  /(^|[\\/])\.zprofile$/,
  /(^|[\\/])\.profile$/,
  /(^|[\\/])\.gitconfig$/,
  // A disk or memory device holds every file on the disk, secrets included:
  // reading one reads them all and writing one overwrites them. The
  // character devices commands use every day (null, zero, random, urandom,
  // tty, stdin, the fd links) are not matched. macOS names its disks disk0
  // and rdisk0. Under Git for Windows /dev/sda is the first physical drive,
  // and it resolves below the current drive; there, and on macOS, the path
  // is already folded to lower case when it is matched.
  new RegExp(`${DEVICE_DIR}(?:sd|hd|vd|xvd)[a-z]`),
  new RegExp(String.raw`${DEVICE_DIR}(?:${NUMBERED_DEVICES.join('|')})\d`),
  new RegExp(`${DEVICE_DIR}(?:k?mem|port)$`),
  new RegExp(String.raw`${DEVICE_DIR}(?:disk[\\/][^\\/]+|mapper|block)[\\/].`),
  /^(?:[a-z]:)?[\\/]proc[\\/]kcore$/,
  /^(?:[a-z]:)?[\\/]proc[\\/](?:\d+|self|thread-self)[\\/](?:task[\\/]\d+[\\/])?mem$/,
  /^\\\\[.?]\\(?:physicaldrive\d|[a-z]:|globalroot\\|harddisk|cdrom\d|tape\d)/,
];

// Where common command-line tools keep a token, a password or a private key,
// at each tool's documented location relative to the home directory: a
// directory when the whole of it is secret, a single file when its
// neighbors are settings, caches or packages an agent may need to read.
const CREDENTIAL_STORES = [
  '.netrc', '_netrc', '.git-credentials', '.config/git/credentials', '.config/gh/hosts.yml', '.config/hub',
  '.docker/config.json', '.kube/config', '.pgpass', '.my.cnf', '.mylogin.cnf', '.yarnrc.yml',
  '.config/gcloud', '.azure', '.terraform.d/credentials.tfrc.json', '.vault-token', '.gem/credentials',
  '.cargo/credentials.toml', '.cargo/credentials', '.m2/settings.xml', '.m2/settings-security.xml',
  '.gradle/gradle.properties', '.s3cfg', '.boto', '.databrickscfg', '.config/rclone/rclone.conf',
  '.password-store', '.local/share/keyrings', '.config/op', '.config/doctl', '.fly/config.yml', '.config/netlify',
  '.local/share/com.vercel.cli', '.config/configstore/firebase-tools.json', '.cache/huggingface/token',
  '.huggingface/token', '.config/composer/auth.json', '.composer/auth.json', '.kaggle', '.oci',
  '.pulumi/credentials.json', '.config/ngrok', '.config/stripe', '.config/sops/age', '.supabase/access-token', '.railway',
  // CodeBuddy keeps the API key of each configured model in models.json; its
  // settings.json neighbor (hooks, non-secret preferences) stays free.
  '.codebuddy/models.json',
  // Browser profiles: saved passwords and session cookies.
  '.mozilla/firefox', '.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge',
  // macOS: the keychains, and the same tools and browsers under Application Support.
  'Library/Keychains', 'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox',
  'Library/Application Support/BraveSoftware', 'Library/Application Support/Microsoft Edge',
  'Library/Application Support/com.vercel.cli', 'Library/Application Support/doctl',
];

export function buildDeniedPaths(): string[] {
  const home = os.homedir();
  const isWindows = process.platform === 'win32';

  const paths = [
    // Pure credential stores: no legitimate reason for an AI tool to write here.
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    ...CREDENTIAL_STORES.map(store => path.join(home, ...store.split('/'))),
    path.join(home, '.egc'),
    // A binary planted here (named e.g. 'git' or 'node') sits ahead of
    // /usr/bin on most PATH configurations, silently hijacking every
    // "safe, allowlisted" command this same guardian trusts by name.
    path.join(home, '.local', 'bin'),
    // User-level systemd units auto-run on login without any further
    // action from the agent that planted one — a persistence mechanism
    // equivalent in effect to a shell rc file.
    path.join(home, '.config', 'systemd', 'user'),
    // ~/.config is XDG_CONFIG_HOME, shared by many unrelated apps and by
    // OpenCode/Zed's functional (non-secret) config, which EGC itself
    // installs into. Deny only the specific subdirectories confirmed to
    // hold credentials for tools that don't expose them elsewhere.
    path.join(home, '.config', 'github-copilot'),
    path.join(home, '.config', 'Trae'),
    '/etc',
  ];

  if (isWindows) {
    const userProfile = process.env.USERPROFILE || home;
    // Where Windows puts them when the variables are unset: a process started
    // with a stripped environment still reads and writes the same folders.
    const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
    // The browser profiles Windows keeps under LocalAppData, and Firefox's
    // own under Roaming instead (its profiles hold logins.json and key4.db,
    // the encrypted saved-password store and its key).
    const browsers = ['Google/Chrome/User Data', 'Microsoft/Edge/User Data', 'BraveSoftware/Brave-Browser/User Data']
      .map(profile => path.join(localAppData, ...profile.split('/')));
    browsers.push(path.join(appData, 'Mozilla', 'Firefox', 'Profiles'));
    // The shell Git for Windows ships reads /etc from its install, where its
    // system gitconfig and profile live: the machine-wide one and the
    // per-user one.
    const programFiles = process.env.ProgramFiles || String.raw`C:\Program Files`;
    paths.push(
      path.join(userProfile, '.ssh'),
      path.join(userProfile, '.aws'),
      // %APPDATA% is shared by many unrelated apps, including EGC's own
      // targets (Antigravity, VS Code Copilot). Deny only the Devin Desktop
      // credentials file; its config.json and cli/sessions.db neighbors are
      // not secret.
      path.join(appData, 'devin', 'credentials.toml'),
      // Windows tools that keep their credentials under %APPDATA% (Roaming)
      // instead of %USERPROFILE%: the home-joined CREDENTIAL_STORES entries
      // resolve to %USERPROFILE% and cover only that tree.
      path.join(appData, 'gcloud'),
      path.join(appData, 'Composer', 'auth.json'),
      path.join(appData, 'configstore', 'firebase-tools.json'),
      path.join(appData, 'stripe', 'config.toml'),
      path.join(appData, 'supabase', 'access-token'),
      ...browsers,
      path.join(programFiles, 'Git', 'etc'),
      path.join(localAppData, 'Programs', 'Git', 'etc'),
    );
  }

  return paths.filter(Boolean);
}

export const DENIED_PATHS: string[] = buildDeniedPaths();

// baseDir defaults to process.cwd() (path.resolve's own implicit behavior
// when given one argument) so existing callers are unaffected. Callers that
// know the real invocation directory of the command being checked (e.g. the
// PreToolUse hook, which receives it from the harness on every call) should
// pass it explicitly -- otherwise a relative path is judged against this
// process's own cwd, which is not guaranteed to match the shell the command
// actually runs in.

export function isProtectedPath(p: string, baseDir: string = process.cwd()): boolean {
  // Trim first: a trailing newline (routine for anything piped through
  // `echo`) or stray whitespace survives path.resolve() into the final
  // string, and every pattern in PROTECTED_FILE_PATTERNS is anchored with
  // `$`, so an untrimmed ".env\n" silently failed to match ".env" and was
  // allowed through (audit EGC-533).
  p = p.trim();

  const expanded = expandHome(p);

  // Resolve symlinks so a link inside an allowed directory cannot point past
  // this check into a denied path. Fall back to the lexical path (then the
  // parent) when the target does not exist yet, e.g. a write being created.
  const normalizedP = resolveRealOrLexical(path.resolve(baseDir, expanded));
  // macOS and Windows open `.ENV`, `/etc/SHADOW` and `~/.SSH/id_rsa` as the
  // very same files their lower-case spellings name, so a comparison that is
  // not folded there protects only one spelling of each secret. Folding is
  // applied to both sides, and only where the filesystem actually behaves
  // that way -- on Linux those are genuinely different files.
  const candidate = foldCase(normalizedP);

  if (isUnderDeniedDirectory(normalizedP)) return true;

  for (const pattern of PROTECTED_FILE_PATTERNS) {
    if (pattern.test(candidate)) {
      return true;
    }
  }

  return isGitControlFile(candidate, isRegularFile(normalizedP)) || isConfiguredHook(normalizedP, baseDir) || isToolHookSurface(p, baseDir);
}

// The cheap half of isProtectedPath, for a whole project walk: the denied
// directories and the secret-file patterns, judged on the path as given.
// isProtectedPath looks every denied directory up on disk and resolves hook
// configuration with dozens of synchronous file-system calls, about 50 ms a
// path, which a walk over thousands of files cannot afford. This checker looks
// the denied directories up once, when it is made, so make a new one for each
// run and nothing outlives it. It resolves no links in the candidate, so it is
// for callers that have already ruled links out (the project indexers read
// only regular files inside the project). Use isProtectedPath for the project
// root and for any file whose content is handed back.
export function secretPathChecker(): (p: string) => boolean {
  const denied = DENIED_PATHS.map(parent => ({ parent, real: resolveRealOrLexical(parent) }));
  return p => {
    const normalizedP = path.resolve(expandHome(p.trim()));
    if (denied.some(d => isUnderResolved(normalizedP, d.parent, d.real))) return true;
    const candidate = foldCase(normalizedP);
    return PROTECTED_FILE_PATTERNS.some(pattern => pattern.test(candidate));
  };
}

// Reading and writing carry different risk, and treating them alike is what
// made the guardian deny `cat ~/.egc/bin/manifest.json`, `ls ~/.egc/bin` or
// `cat /etc/systemd/oomd.conf` -- none of which expose a secret, all of
// which someone diagnosing their own install genuinely needs. Writing into
// those directories can hijack execution or plant persistence, so every
// write denial stays exactly as it was.
//
// Derived from the write protection by subtraction, never restated: a read
// is denied wherever a write is denied, EXCEPT for the locations listed
// here. Stating the readable set positively (rather than re-listing what to
// deny) means a credential store added to the write protection tomorrow is
// read-protected automatically, instead of silently becoming readable
// because a parallel list was not updated.
//
// Deliberately narrow: specific directories whose entire contents are
// operational, never a whole tree with secrets carved back out. Opening
// /etc or ~/.egc wholesale and then listing the secrets inside them is a
// denylist wearing an allowlist's clothes, and it leaks by omission -- an
// audit of exactly that shape turned up /etc/ssl/private, /etc/wireguard,
// /etc/krb5.keytab, the shadow backup files (/etc/shadow-), and
// ~/.egc/encryption.key.bak, none of which had been listed. Anything not
// named here stays denied, so a secret nobody thought of stays protected.
function buildReadSafePaths(): string[] {
  const home = os.homedir();
  return [
    // EGC's own install surface: shim manifest and the binaries it wraps.
    path.join(home, '.egc', 'bin'),
    // Token Crusher ledger, which `egc gain` reports from.
    path.join(home, '.egc', 'metrics'),
    path.join(home, '.egc', 'logs'),
    // Service definitions: what runs, and how.
    '/etc/systemd',
    path.join(home, '.config', 'systemd', 'user'),
    // Listing what sits ahead of /usr/bin on PATH is diagnosis, not exposure.
    path.join(home, '.local', 'bin'),
  ];
}

export const READ_SAFE_PATHS: string[] = buildReadSafePaths();

// Files that are dangerous to modify but harmless to read: shell startup
// files and git config are persistence mechanisms, not credential stores.
// Anchored, and only ever consulted for a path that is NOT inside a denied
// directory -- otherwise a file named ~/.ssh/.gitconfig would read as safe.
const READ_SAFE_FILE_PATTERNS: RegExp[] = [
  /(^|[\\/])\.(bashrc|zshrc|bash_profile|zprofile|profile)$/,
  /(^|[\\/])\.gitconfig$/,
];

// A path with its Windows drive letter taken off.
function withoutDrive(p: string): string {
  return p.replace(/^[a-z]:/i, '');
}

// A POSIX system path (`/etc`) has no drive: a shell on Windows reads it
// from its own root, and Node resolves it below whichever drive is current,
// so there it is matched below any drive.
function isUnder(candidate: string, parent: string): boolean {
  return isUnderResolved(candidate, parent, resolveRealOrLexical(parent));
}

// isUnder with the parent's real location already looked up.
function isUnderResolved(candidate: string, parent: string, realParent: string): boolean {
  const driveless = process.platform === 'win32' && parent.startsWith('/');
  const resolvedParent = foldCase(realParent);
  const folded = foldCase(candidate);
  const [inside, above] = driveless ? [withoutDrive(folded), withoutDrive(resolvedParent)] : [folded, resolvedParent];
  return inside === above || inside.startsWith(above + path.sep);
}

// Whether the protection comes from the path living inside a denied
// directory (a credential store) rather than from the filename alone.
function isUnderDeniedDirectory(normalizedP: string): boolean {
  return DENIED_PATHS.some(denied => isUnder(normalizedP, denied));
}

export function isReadDeniedPath(p: string, baseDir: string = process.cwd()): boolean {
  // Not protected at all: nothing to decide.
  if (!isProtectedPath(p, baseDir)) return false;

  const trimmed = p.trim();
  const expanded = expandHome(trimmed);
  const normalizedP = resolveRealOrLexical(path.resolve(baseDir, expanded));

  // An explicitly operational location is readable.
  if (READ_SAFE_PATHS.some(safe => isUnder(normalizedP, safe))) return false;

  // Inside a credential store, the filename means nothing: deny.
  if (isUnderDeniedDirectory(normalizedP)) return true;

  // Protection came from the filename alone. Allow the persistence-only
  // ones; everything else (.env, .pem, tokens, auth files) stays denied.
  // Folded on the same terms as the denial side: where the filesystem opens
  // ~/.BASHRC and ~/.bashrc as one file, both spellings have to be readable,
  // or the case fix would have quietly turned a harmless read into a denial.
  // A git directory's config and hooks are persistence too, and so are the
  // hooks git runs from elsewhere; a secret's name keeps it denied even there.
  const folded = foldCase(normalizedP);
  return !READ_SAFE_FILE_PATTERNS.some(pattern => pattern.test(folded)) && PROTECTED_FILE_PATTERNS.some(pattern => pattern.test(folded));
}
