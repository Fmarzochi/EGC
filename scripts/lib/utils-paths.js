/**
 * EGC directory and session-path resolution for hooks and scripts.
 * Works on Windows, macOS, and Linux.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isWindows } = require('./utils-platform');

const SESSION_DATA_DIR_NAME = 'session-data';
const LEGACY_SESSIONS_DIR_NAME = 'sessions';

/**
 * Get the user's home directory (cross-platform)
 */
function getHomeDir() {
  // Each candidate is validated independently: a whitespace-only HOME must
  // not shadow a valid USERPROFILE (cubic review, confidence 9 -- the prior
  // version picked HOME over USERPROFILE with the || operator before
  // trimming either one, so a blank-but-truthy HOME fell straight through
  // to os.homedir() and skipped a perfectly good USERPROFILE on the way).
  for (const candidate of [process.env.HOME, process.env.USERPROFILE]) {
    if (candidate && candidate.trim().length > 0) {
      return path.resolve(candidate);
    }
  }
  return os.homedir();
}

/**
 * Get the EGC config directory
 * @deprecated Use getEGCDir() for canonical EGC runtime.
 */
function getClaudeDir() {
  return getEGCDir();
}

// Tier 1: harness-specific env vars injected at hook time. The Gemini
// variables come first: the retired Gemini CLI set the Claude ones too as a
// compat alias, and Antigravity inherited its hook loop and its variables
// (antigravity.google/docs/hooks). Claude Code sets CLAUDECODE in the
// shell its Bash tool runs, where CLAUDE_PROJECT_DIR is absent.
function resolveHarnessDirFromEnv(env, home) {
  if (env.GEMINI_PROJECT_DIR || env.GEMINI_PLUGIN_ROOT) return path.join(home, '.gemini');
  if (env.CLAUDECODE || env.CLAUDE_PROJECT_DIR || env.CLAUDE_PLUGIN_ROOT) return path.join(home, '.claude');
  if (env.CODEBUDDY_PROJECT_DIR || env.CODEBUDDY_PLUGIN_ROOT) return path.join(home, '.codebuddy');
  if (env.VSCODE_AGENT || env.GITHUB_COPILOT_API_TOKEN) return path.join(home, '.github');
  if (env.KIRO_HOOK_FILE || env.KIRO_FILE_PATH) return path.join(home, '.kiro');
  if (env.TRAE_ENV) return path.join(home, env.TRAE_ENV === 'cn' ? '.trae-cn' : '.trae');
  return null;
}

// Longest-prefix-first to avoid false matches (e.g. .config/opencode before .config).
function getKnownHarnessDirs(home) {
  return [
    path.join(home, '.codeium', 'windsurf'),
    path.join(home, '.config', 'opencode'),
    path.join(home, '.config', 'zed'),
    path.join(home, '.gemini'),
    path.join(home, '.claude'),
    path.join(home, '.cursor'),
    path.join(home, '.agents'),
    path.join(home, '.amp'),
    path.join(home, '.continue'),
    path.join(home, '.github'),
    path.join(home, '.kiro'),
    path.join(home, '.trae'),
    path.join(home, '.trae-cn'),
    path.join(home, '.codebuddy'),
  ];
}

// Tier 2: __dirname prefix match (harnesses without unique runtime env vars at hook time).
function resolveHarnessDirFromDirname(harnessDirs) {
  const sep = path.sep;
  for (const dir of harnessDirs) {
    if (__dirname === dir || __dirname.startsWith(dir + sep)) return dir;
  }
  return null;
}

// Tier 3b: first existing harness dir under HOME (dev/test environments where
// __dirname points to the source repo rather than a harness install path,
// and ~/.egc hasn't been created yet).
function resolveFirstExistingHarnessDir(harnessDirs) {
  for (const dir of harnessDirs) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/**
 * The EGC directory under a given home, by the tiers 2 to 5 below. A caller
 * that inspects another home (skills-health --home, a test fixture) gets the
 * same answer the hooks got when they wrote there, instead of a fixed tool
 * directory of its own. EGC_DIR is the caller's business: getEGCDir()
 * applies it, this function does not.
 */
function resolveEGCDir(home) {
  const envMatch = resolveHarnessDirFromEnv(process.env, home);
  if (envMatch) return envMatch;

  const harnessDirs = getKnownHarnessDirs(home);
  const dirnameMatch = resolveHarnessDirFromDirname(harnessDirs);
  if (dirnameMatch) return dirnameMatch;

  const egcDir = path.join(home, '.egc');
  if (fs.existsSync(egcDir)) return egcDir;

  return resolveFirstExistingHarnessDir(harnessDirs) || egcDir;
}

/**
 * Get the EGC config directory for the active harness.
 *
 * Resolution order:
 *   1. EGC_DIR env var (explicit override)
 *   2. Harness-specific env vars injected at hook time
 *   3. __dirname prefix match against known harness home dirs (production install)
 *   4. ~/.egc if it already exists (BUG-08: the tool-agnostic default must win over
 *      "first installed harness dir" once initialized, or a bare terminal invocation
 *      silently splits state into whichever tool happens to be installed)
 *   5. first existing harness dir under HOME, else ~/.egc (fresh dev/test environment)
 */
function getEGCDir() {
  if (process.env.EGC_DIR) return process.env.EGC_DIR;
  return resolveEGCDir(getHomeDir());
}

/**
 * The continuous-learning store (observations, instincts, evolved skills),
 * one folder for every tool. It stays outside ~/.egc because the observer
 * agent writes instincts itself and the Guardian refuses agent writes there;
 * the shell hooks, instinct-cli.py, src/llm/paths.py and the memory server
 * resolve the same folder.
 */
function getLearningDir() {
  return path.join(getHomeDir(), '.egc-learning');
}

/**
 * Get the sessions directory
 */
function getSessionsDir() {
  return path.join(getEGCDir(), SESSION_DATA_DIR_NAME);
}

/**
 * Get the legacy sessions directory used by older EGC installs
 */
function getLegacySessionsDir() {
  return path.join(getEGCDir(), LEGACY_SESSIONS_DIR_NAME);
}

/**
 * Get all session directories to search, in canonical-first order
 */
function getSessionSearchDirs() {
  return Array.from(new Set([getSessionsDir(), getLegacySessionsDir()]));
}

/**
 * Get the learned skills directory
 */
function getLearnedSkillsDir() {
  return path.join(getEGCDir(), 'skills', 'learned');
}

/**
 * Get the temp directory (cross-platform)
 */
function getTempDir() {
  return os.tmpdir();
}

/**
 * Ensure a directory exists (create if not)
 * @param {string} dirPath - Directory path to create
 * @returns {string} The directory path
 * @throws {Error} If directory cannot be created (e.g., permission denied)
 */
function ensureDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch (err) {
    // EEXIST is fine (race condition with another process creating it)
    if (err.code !== 'EEXIST') {
      throw new Error(`Failed to create directory '${dirPath}': ${err.message}`, { cause: err });
    }
  }
  return dirPath;
}

/**
 * Ensure a private directory exists with restricted permissions (owner only).
 * On POSIX systems this sets mode 0700 at creation time and re-enforces it on
 * already-existing directories. On Windows permissions are unchanged.
 * @param {string} dirPath - Directory path to create
 * @returns {string} The directory path
 */
function ensurePrivateDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 }); // NOSONAR jssecurity:S8707
    }
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw new Error(`Failed to create directory '${dirPath}': ${err.message}`, { cause: err });
    }
  }
  if (!isWindows) {
    try {
      fs.chmodSync(dirPath, 0o700); // NOSONAR jssecurity:S8707
    } catch {
      // best-effort -- do not crash if chmod is not supported (e.g. tmpfs)
    }
  }
  return dirPath;
}

module.exports = {
  getHomeDir,
  getEGCDir,
  getLearningDir,
  resolveEGCDir,
  getKnownHarnessDirs,
  resolveHarnessDirFromEnv,
  getClaudeDir, // NOSONAR: deprecated alias kept as a public export for backward compatibility
  getSessionsDir,
  getLegacySessionsDir,
  getSessionSearchDirs,
  getLearnedSkillsDir,
  getTempDir,
  ensureDir,
  ensurePrivateDir,
};
