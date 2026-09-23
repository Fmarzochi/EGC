'use strict';

// Configures the git clean filter that strips populated EGC memory from the
// propagation files at staging time. Everything stays local to the repo:
// filter config goes to .git/config and the file bindings to
// .git/info/attributes, so nothing the user commits is touched. The caller
// prints every action returned here before applying (installer transparency
// requirement: no silent global changes).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// S4036: prefer fixed git locations over a PATH lookup; the bare name is the
// last resort for layouts like nix or Windows portable installs.
const GIT_BIN = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
].find(p => fs.existsSync(p)) || 'git';

// POSIX single-quote escaping: git always resolves filter.<x>.clean through
// its own bundled POSIX-like shell (sh on Linux/macOS, Git for Windows'
// MSYS2 sh.exe on Windows -- never native cmd.exe), so single-quoting is
// correct cross-platform here. Without this, a scriptPath containing a
// space, quote, `$`, or backtick could break the command or be interpreted
// by the shell.
function shSingleQuote(value) {
  const escaped = value.replaceAll("'", String.raw`'\''`);
  return `'${escaped}'`;
}

const FILTER_NAME = 'egc-memory';
const PROPAGATION_FILES = [
  'AGENTS.md',
  'GEMINI.md',
  '.cursor/rules/egc-context.mdc',
  '.trae/rules/egc-context.md',
  '.github/copilot-instructions.md',
  '.windsurf/rules/egc-context.md',
  '.rules',
  '.clinerules',
  '.cursorrules',
  'CONVENTIONS.md',
  'llms.txt',
  'CLAUDE.md',
];

// --git-path (not --git-dir + a manual join) resolves correctly for linked
// worktrees too: git always reads info/attributes from the *common* git
// directory, never the per-worktree one that --git-dir alone returns
// (.git/worktrees/<name>) when run inside a linked worktree. Building the
// path by hand from --git-dir would silently write bindings to a file git
// never consults there, leaving worktree-based projects unprotected.
// A .git entry of any kind, a symlink included even when it dangles: git
// accepts .git as a link, and one that points nowhere is a checkout git
// cannot open, not a directory outside any repository.
function hasGitEntry(dir) {
  try {
    fs.lstatSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

// Whether projectDir sits inside a git working tree, judged from the
// filesystem alone: a .git entry (a directory, or the file a linked worktree
// and a submodule carry) in the directory or any parent. Consulted when git
// itself cannot answer, so a tree git cannot open (a worktree whose gitdir
// moved, a checkout git refuses to read) is still known to be a repository
// and reported apart from a directory that is no repository at all.
function isInsideGitWorkTree(projectDir) {
  // The real path, so a symlinked project directory is walked where it
  // actually lives; a path that does not exist keeps its resolved form.
  let dir;
  try {
    dir = fs.realpathSync(projectDir);
  } catch {
    dir = path.resolve(projectDir);
  }
  let parent = path.dirname(dir);
  while (parent !== dir) {
    if (hasGitEntry(dir)) return true;
    dir = parent;
    parent = path.dirname(dir);
  }
  return hasGitEntry(dir);
}

function resolveAttributesFile(projectDir) {
  try {
    const raw = execFileSync(GIT_BIN, ['rev-parse', '--git-path', 'info/attributes'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.isAbsolute(raw) ? raw : path.join(projectDir, raw);
  } catch {
    return null;
  }
}

// A repo whose filter was set up before required=true existed would
// otherwise stay silently fail-open forever once the script goes missing,
// with no path back to fail-closed. Harden an already-present driver in
// place -- without touching its clean command or adding new bindings -- so
// a broken script at least blocks staging instead of silently falling back
// to unfiltered content. A driver that was never configured at all needs no
// change.
function hardenMissingScriptFilter(projectDir, scriptPath, dryRun) {
  if (!dryRun) {
    const alreadyConfigured = readLocalConfig(projectDir, `filter.${FILTER_NAME}.clean`) !== null;
    if (alreadyConfigured) {
      // A driver configured before the smudge fix existed may have only
      // `clean` set. Hardening straight to required=true here without also
      // ensuring `smudge=cat` would turn every checkout/worktree/clone on
      // this repo into a hard "smudge filter egc-memory failed" failure.
      writeLocalConfig(projectDir, `filter.${FILTER_NAME}.smudge`, 'cat');
      writeLocalConfig(projectDir, `filter.${FILTER_NAME}.required`, 'true');
    }
  }
  return { configured: false, reason: `clean-filter script not found at ${scriptPath}`, actions: [] };
}

// Exact-line matching (not a raw substring test): a commented-out entry or
// a line with extra trailing content would still satisfy .includes(),
// silently skipping the real binding this project needs.
function computeMissingBindings(attributesFile) {
  let existing = '';
  try {
    existing = fs.readFileSync(attributesFile, 'utf8');
  } catch { /* first configuration: attributes file does not exist yet */ }
  const existingLines = new Set(existing.split('\n').map(l => l.trim()));
  const missing = PROPAGATION_FILES.filter(file => !existingLines.has(`${file} filter=${FILTER_NAME}`));
  return { existing, missing };
}

// `git config` honours GIT_CONFIG as an alternate file for both reads and
// writes. The filter only protects this repository when it lives in
// .git/config, so the variable is dropped and the local file is named
// explicitly on every read and write below.
function localConfigEnv() {
  const env = { ...process.env, GIT_CONFIG: undefined };
  delete env.GIT_CONFIG;
  return env;
}

// The local value of one filter key, or null when it is not set. Only the
// repository config is read: a global or system value does not protect this
// repo's worktree the way the local one does, so it is not counted as
// configured.
function readLocalConfig(projectDir, key) {
  try {
    return execFileSync(GIT_BIN, ['config', '--local', '--get', key], {
      cwd: projectDir,
      encoding: 'utf8',
      env: localConfigEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\n$/, '');
  } catch {
    return null;
  }
}

// The three filter keys and the value each one must carry. required=true
// makes git refuse to stage a file through this filter if the clean command
// itself fails, instead of silently falling back to the original
// (unfiltered, still populated) content: fail-closed matches the README's
// unconditional "never gets committed to git" promise. The smudge side puts
// the memory back: git hands it the zeroed blob it is checking out and gets
// the block of the local state in return, so a pull, a branch switch or a
// stash pop never leaves the working tree without the memory; where node or
// the script is not there the blob goes through as committed, decided
// before anything reads stdin, and inside the script whatever stands in the
// way the content goes out as it came. Setting it explicitly also matters because required=true
// turns an *unconfigured* smudge side into a hard failure instead of the
// passthru git defaults to when a filter driver is missing entirely
// (gitattributes(5)): once clean is set, checkout/worktree/clone on this
// repo would fail with "smudge filter egc-memory failed" without an
// explicit smudge command.
function desiredFilterConfig(cleanCommand, smudgeCommand) {
  return [
    { key: `filter.${FILTER_NAME}.clean`, value: cleanCommand, shown: `"${cleanCommand}"` },
    { key: `filter.${FILTER_NAME}.smudge`, value: smudgeCommand, shown: `"${smudgeCommand}"` },
    { key: `filter.${FILTER_NAME}.required`, value: 'true', shown: 'true' },
  ];
}

// Only the keys whose local value differs from the desired one are planned,
// so a second run on a configured repo reports no change instead of the
// same three writes every time.
function computeMissingConfig(projectDir, cleanCommand, smudgeCommand) {
  return desiredFilterConfig(cleanCommand, smudgeCommand).filter(entry => readLocalConfig(projectDir, entry.key) !== entry.value);
}

function writeLocalConfig(projectDir, key, value) {
  execFileSync(GIT_BIN, ['config', '--local', key, value], {
    cwd: projectDir,
    encoding: 'utf8',
    env: localConfigEnv(),
  });
}

function applyFilterConfig(projectDir, missingConfig, attributesFile, existing, missingBindings) {
  for (const entry of missingConfig) writeLocalConfig(projectDir, entry.key, entry.value);
  if (missingBindings.length > 0) {
    fs.mkdirSync(path.dirname(attributesFile), { recursive: true });
    const header = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    const lines = missingBindings.map(f => `${f} filter=${FILTER_NAME}\n`).join('');
    fs.appendFileSync(attributesFile, header + lines);
  }
}

// Returns the action plan without touching anything when dryRun is true.
// `actions` lists only what is not in place yet: an empty list on a
// configured repo means the filter is already there and nothing is written.
function configureMemoryFilters({ projectDir, scriptPath, dryRun = false }) {
  const attributesFile = resolveAttributesFile(projectDir);
  if (!attributesFile) {
    const reason = isInsideGitWorkTree(projectDir)
      ? 'git could not open the repository this directory is in'
      : 'not a git repository';
    return { configured: false, reason, actions: [] };
  }

  // If the script this filter depends on isn't even on disk, configuring the
  // filter anyway would silently commit unfiltered memory the moment git
  // tries (and fails) to run it -- fail closed instead: never configure.
  if (!fs.existsSync(scriptPath)) {
    return hardenMissingScriptFilter(projectDir, scriptPath, dryRun);
  }

  const cleanCommand = `node ${shSingleQuote(scriptPath)} --filter-clean`;
  const smudgeCommand = `if command -v node >/dev/null 2>&1 && [ -f ${shSingleQuote(scriptPath)} ]; then node ${shSingleQuote(scriptPath)} --filter-smudge %f; else cat; fi`;
  const missingConfig = computeMissingConfig(projectDir, cleanCommand, smudgeCommand);
  const actions = missingConfig.map(entry => `git config ${entry.key} ${entry.shown} (local repo config)`);

  const { existing, missing: missingBindings } = computeMissingBindings(attributesFile);
  for (const file of missingBindings) {
    actions.push(`bind ${file} to filter=${FILTER_NAME} (.git/info/attributes)`);
  }

  if (!dryRun) {
    applyFilterConfig(projectDir, missingConfig, attributesFile, existing, missingBindings);
  }

  return { configured: true, actions, attributesFile };
}

// Shared CLI-facing wrapper: runs the dry-run plan first so a caller prints
// the same transparency log before touching anything, then applies it for
// real. Used by install-apply.js (both the bare `egc install` delegation
// branch and the `egc install --target X` path) and by the inline node
// snippets in install.sh/install.ps1. `egc init` keeps its own copy in
// init.js's configureCommitPrivacyFilter (same configureMemoryFilters call
// underneath, own dry-run/logging conventions) rather than this wrapper.
// Extracted so the README's "never gets committed to git" promise is kept
// by every path that can create the repo's first commit, not only `egc
// init` -- the gap a 2026-08-01 audit found (install.sh/install.ps1/
// install-apply.js never called this at all, only egc init did).
function applyCommitPrivacyFilterCli({ projectDir, scriptPath, log }) {
  const plan = configureMemoryFilters({ projectDir, scriptPath, dryRun: true });
  if (!plan.configured) {
    log(`skip commit-privacy filter: ${plan.reason}`);
    return plan;
  }
  if (plan.actions.length === 0) {
    log('commit-privacy filter: already configured (local repo only)');
    return plan;
  }
  for (const action of plan.actions) log(`commit-privacy filter: ${action}`);
  const result = configureMemoryFilters({ projectDir, scriptPath, dryRun: false });
  log(`commit-privacy filter: populated memory is stripped from staged blobs (${result.actions.length} change(s), local repo only)`);
  return result;
}

// The same step scripts/lib/propagate-state.js carries for the hooks (that
// file is copied on its own, so it cannot share this one).
// A mirror rewritten with another size reads as modified to git until its
// index entry is looked at again: git trusts the size it recorded and does
// not run the clean side of the filter, so a branch switch after a session
// start was refused for a file that carried nothing new. Feeding the
// entries of the written files back through update-index clears the
// recorded stat, and the refresh that follows hashes them through the
// filter and records what it finds: a mirror that still cleans to the
// committed blob reads as unmodified, a change of the user's own stays an
// unstaged change, and nothing is ever staged (a path handed to
// update-index directly would be re-added with its current content). A
// step that cannot run (no git, no repository, an index held by another
// git) changes nothing: git recomputes the same information on its next
// command.
function forgetIndexStat(projectPath, files) {
  if (files.length === 0) return;
  const relative = files.map(file => path.relative(projectPath, file));
  try {
    const entries = execFileSync(GIT_BIN, ['ls-files', '-s', '-z', '--', ...relative], {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (entries.length === 0) return;
    execFileSync(GIT_BIN, ['update-index', '-z', '--index-info'], {
      cwd: projectPath,
      input: entries,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    execFileSync(GIT_BIN, ['update-index', '-q', '--unmerged', '--refresh'], {
      cwd: projectPath,
      stdio: 'ignore',
    });
  } catch {
    // Nothing to undo: the entries are read again by the next git command.
  }
}

module.exports = { FILTER_NAME, PROPAGATION_FILES, applyCommitPrivacyFilterCli, configureMemoryFilters, forgetIndexStat };
