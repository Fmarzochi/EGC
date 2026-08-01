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
  '.roo/rules/egc-context.md',
  '.continue/rules/egc-context.md',
];

function gitDir(projectDir) {
  try {
    return execFileSync(GIT_BIN, ['rev-parse', '--git-dir'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// Returns the action plan without touching anything when dryRun is true.
function configureMemoryFilters({ projectDir, scriptPath, dryRun = false }) {
  const resolvedGitDir = gitDir(projectDir);
  if (!resolvedGitDir) {
    return { configured: false, reason: 'not a git repository', actions: [] };
  }

  // If the script this filter depends on isn't even on disk, configuring the
  // filter anyway would silently commit unfiltered memory the moment git
  // tries (and fails) to run it -- fail closed instead: never configure.
  if (!fs.existsSync(scriptPath)) {
    return { configured: false, reason: `clean-filter script not found at ${scriptPath}`, actions: [] };
  }

  const absoluteGitDir = path.isAbsolute(resolvedGitDir)
    ? resolvedGitDir
    : path.join(projectDir, resolvedGitDir);
  const attributesFile = path.join(absoluteGitDir, 'info', 'attributes');
  const cleanCommand = `node ${shSingleQuote(scriptPath)} --filter-clean`;

  const actions = [
    `git config filter.${FILTER_NAME}.clean '${cleanCommand}' (local repo config)`,
    // required=true makes git refuse to stage a file through this filter if
    // the clean command itself fails, instead of silently falling back to
    // the original (unfiltered, still populated) content -- fail-closed
    // matches the README's unconditional "never gets committed to git"
    // promise. But required=true also turns an *unconfigured* smudge side
    // into a hard failure instead of the passthru git defaults to when a
    // filter driver is missing entirely (gitattributes(5)): once clean is
    // set, checkout/worktree/clone on this repo starts failing with "smudge
    // filter egc-memory failed" without an explicit smudge command. cat is
    // configured as an identity smudge: the working tree keeps whatever
    // content is checked out, only the staged blob gets cleaned.
    `git config filter.${FILTER_NAME}.smudge cat (local repo config)`,
    `git config filter.${FILTER_NAME}.required true (local repo config)`,
  ];

  let existing = '';
  try {
    existing = fs.readFileSync(attributesFile, 'utf8');
  } catch { /* first configuration: attributes file does not exist yet */ }

  // Exact-line matching (not a raw substring test): a commented-out entry or
  // a line with extra trailing content would still satisfy .includes(),
  // silently skipping the real binding this project needs.
  const existingLines = new Set(existing.split('\n').map(l => l.trim()));
  const missingBindings = PROPAGATION_FILES.filter(
    file => !existingLines.has(`${file} filter=${FILTER_NAME}`)
  );
  for (const file of missingBindings) {
    actions.push(`bind ${file} to filter=${FILTER_NAME} (.git/info/attributes)`);
  }

  if (!dryRun) {
    execFileSync(GIT_BIN, ['config', `filter.${FILTER_NAME}.clean`, cleanCommand], {
      cwd: projectDir,
      encoding: 'utf8',
    });
    execFileSync(GIT_BIN, ['config', `filter.${FILTER_NAME}.smudge`, 'cat'], {
      cwd: projectDir,
      encoding: 'utf8',
    });
    execFileSync(GIT_BIN, ['config', `filter.${FILTER_NAME}.required`, 'true'], {
      cwd: projectDir,
      encoding: 'utf8',
    });
    if (missingBindings.length > 0) {
      fs.mkdirSync(path.dirname(attributesFile), { recursive: true });
      const header = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      const lines = missingBindings.map(f => `${f} filter=${FILTER_NAME}\n`).join('');
      fs.appendFileSync(attributesFile, header + lines);
    }
  }

  return { configured: true, actions, attributesFile };
}

module.exports = { FILTER_NAME, PROPAGATION_FILES, configureMemoryFilters };
