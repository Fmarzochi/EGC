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
  'C:\\Program Files\\Git\\cmd\\git.exe',
].find(p => fs.existsSync(p)) || 'git';

const FILTER_NAME = 'egc-memory';
const PROPAGATION_FILES = [
  'AGENTS.md',
  'GEMINI.md',
  '.cursor/rules/egc-context.mdc',
  '.trae/rules/egc-context.md',
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

  const absoluteGitDir = path.isAbsolute(resolvedGitDir)
    ? resolvedGitDir
    : path.join(projectDir, resolvedGitDir);
  const attributesFile = path.join(absoluteGitDir, 'info', 'attributes');
  const cleanCommand = `node "${scriptPath}" --filter-clean`;

  const actions = [
    `git config filter.${FILTER_NAME}.clean '${cleanCommand}' (local repo config)`,
  ];

  let existing = '';
  try {
    existing = fs.readFileSync(attributesFile, 'utf8');
  } catch { /* first configuration: attributes file does not exist yet */ }

  const missingBindings = PROPAGATION_FILES.filter(
    file => !existing.includes(`${file} filter=${FILTER_NAME}`)
  );
  for (const file of missingBindings) {
    actions.push(`bind ${file} to filter=${FILTER_NAME} (.git/info/attributes)`);
  }

  if (!dryRun) {
    execFileSync(GIT_BIN, ['config', `filter.${FILTER_NAME}.clean`, cleanCommand], {
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
