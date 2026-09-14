'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { getHomeDir, getKnownHarnessDirs, resolveHarnessDirFromEnv } = require('./utils');

// Project-scoped install targets keep their state at <project>/<dir>/egc-install-state.json,
// home targets at <harness root>/egc/install-state.json (scripts/lib/install-executor.js).
const PROJECT_STATE_DIRS = ['.claude', '.gemini', '.cursor', '.agents', '.codex', '.github', '.kiro', '.trae', '.trae-cn', '.codebuddy', '.windsurf', '.opencode', '.zed', '.amp', '.continue'];
const HOME_STATE = ['egc', 'install-state.json'];
const PROJECT_STATE = 'egc-install-state.json';

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.operations) ? parsed : null;
  } catch (_) { // NOSONAR: a missing or unreadable state is simply not counted
    return null;
  }
}

function sourcesOf(state) {
  const sources = [];
  for (const operation of state.operations) {
    if (operation && typeof operation.sourceRelativePath === 'string') {
      sources.push(operation.sourceRelativePath.split(path.sep).join('/'));
    }
  }
  return sources;
}

// The install states that describe what the active tool can invoke. With a
// harness variable in the environment, only that harness counts (its home
// state and its project state under cwd); without one, every known harness
// state is read, which can only over-approximate what is installed.
function stateFilesFor({ environment, cwd, homeDir }) {
  const harnessRoot = resolveHarnessDirFromEnv(environment, homeDir);
  const homeRoots = harnessRoot ? [harnessRoot] : getKnownHarnessDirs(homeDir);
  const projectDirs = harnessRoot ? [path.basename(harnessRoot)] : PROJECT_STATE_DIRS;
  const files = [];
  for (const root of homeRoots) files.push(path.join(root, ...HOME_STATE));
  for (const dir of projectDirs) files.push(path.join(cwd, dir, PROJECT_STATE));
  return { harnessRoot, files: Array.from(new Set(files)) };
}

// What the active tool has installed, as the source paths the install state
// recorded. known is false when no install state was found at all, in which
// case nothing can be said about what is installed.
function installedComponentSources(options = {}) {
  const environment = options.environment || process.env;
  const cwd = options.cwd || process.cwd();
  const homeDir = options.homeDir || getHomeDir();
  const { harnessRoot, files } = stateFilesFor({ environment, cwd, homeDir });
  const sources = new Set();
  let states = 0;
  for (const file of files) {
    const state = readState(file);
    if (!state) continue;
    states += 1;
    for (const source of sourcesOf(state)) sources.add(source);
  }
  return { known: states > 0, harnessRoot, sources };
}

// Splits catalog entries into what the tool can invoke and what only exists
// in the catalog. Entries without a recorded source (an older index) are
// treated as installed, the behavior before sources were recorded.
function splitByInstallation(entries, installed) {
  const available = [];
  const missing = [];
  for (const entry of entries) {
    if (!installed.known || !entry.source || installed.sources.has(entry.source)) available.push(entry);
    else missing.push(entry);
  }
  return { available, missing };
}

const INSTALL_HINT = 'egc install --prompt-library (every detected tool) or egc install --target <tool> --profile full';

module.exports = { installedComponentSources, splitByInstallation, INSTALL_HINT, PROJECT_STATE_DIRS };
