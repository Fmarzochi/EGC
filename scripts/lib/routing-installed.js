'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { getHomeDir, getKnownHarnessDirs, resolveHarnessDirFromEnv } = require('./utils');

// Project-scoped install targets keep their state at <project>/<dir>/egc-install-state.json,
// home targets at <harness root>/egc/install-state.json (scripts/lib/install-executor.js).
const PROJECT_STATE_DIRS = ['.claude', '.gemini', '.cursor', '.agents', '.codex', '.github', '.kiro', '.trae', '.trae-cn', '.codebuddy', '.windsurf', '.opencode', '.zed', '.amp', '.continue'];
// Home targets write <root>/egc/install-state.json; the targets that share the
// .agents root (Codex, Goose, OpenHands) write <root>/egc/<tool>-install-state.json,
// so every state file in that directory counts.
const HOME_STATE_DIR = 'egc';
const STATE_SUFFIX = 'install-state.json';
const PROJECT_STATE = 'egc-install-state.json';

// The tool behind a routing call when its environment carries no variable:
// the client name of the MCP initialize handshake, matched loosely, since
// each tool names its client its own way. A name that matches nothing
// leaves the harness unknown, as before.
const CLIENT_NAME_HARNESS_DIRS = Object.freeze([
  [/claude/i, ['.claude']],
  [/gemini|antigravity/i, ['.gemini']],
  [/codebuddy/i, ['.codebuddy']],
  // The VS Code forks name themselves before the generic VS Code rule
  // catches them.
  [/cursor/i, ['.cursor']],
  [/windsurf|codeium/i, ['.codeium', 'windsurf']],
  [/copilot|vscode|visual studio/i, ['.github']],
  [/kiro/i, ['.kiro']],
  [/trae/i, ['.trae']],
  [/opencode/i, ['.config', 'opencode']],
  [/zed/i, ['.config', 'zed']],
  [/codex|goose|openhands/i, ['.agents']],
  [/\bamp\b/i, ['.amp']],
  [/junie|jetbrains/i, ['.junie']],
]);

function harnessDirFromClientName(clientName, homeDir) {
  if (typeof clientName !== 'string' || clientName.length === 0) return null;
  for (const [pattern, segments] of CLIENT_NAME_HARNESS_DIRS) {
    if (pattern.test(clientName)) return path.join(homeDir, ...segments);
  }
  return null;
}

// A state file that is missing is simply absent; one that exists but cannot
// be read or parsed is reported as unreadable and contributes nothing, so a
// corrupt state never turns into "everything is installed".
function readState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) { // NOSONAR: absent (or unreadable, reported below by the caller)
    return fs.existsSync(file) ? { unreadable: true } : null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.operations) ? { state: parsed } : { unreadable: true };
  } catch (_) { // NOSONAR: malformed state is unreadable, not absent
    return { unreadable: true };
  }
}

function homeStateFiles(root) {
  const dir = path.join(root, HOME_STATE_DIR);
  try {
    return fs.readdirSync(dir).filter(name => name.endsWith(STATE_SUFFIX)).map(name => path.join(dir, name));
  } catch (_) { // NOSONAR: no egc directory under this root
    return [];
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
function stateFilesFor({ environment, cwd, homeDir, clientName }) {
  const harnessRoot = resolveHarnessDirFromEnv(environment, homeDir) || harnessDirFromClientName(clientName, homeDir);
  const homeRoots = harnessRoot ? [harnessRoot] : getKnownHarnessDirs(homeDir);
  const projectDirs = harnessRoot ? [path.basename(harnessRoot)] : PROJECT_STATE_DIRS;
  const files = [];
  for (const root of homeRoots) files.push(...homeStateFiles(root));
  for (const dir of projectDirs) files.push(path.join(cwd, dir, PROJECT_STATE));
  return { harnessRoot, files: Array.from(new Set(files)) };
}

// What the active tool has installed, as the source paths the install state
// recorded. A tool named by the environment with no install state at all is
// a bare install: known, with nothing installed. Without a harness variable
// every known state is read, and none at all leaves the split unknown. An
// unreadable state counts as found (known) and adds no source, so its
// components read as not installed rather than as available.
function installedComponentSources(options = {}) {
  const environment = options.environment || process.env;
  const cwd = options.cwd || process.cwd();
  const homeDir = options.homeDir || getHomeDir();
  const { harnessRoot, files } = stateFilesFor({ environment, cwd, homeDir, clientName: options.clientName });
  const sources = new Set();
  let states = 0;
  let unreadable = 0;
  for (const file of files) {
    const read = readState(file);
    if (!read) continue;
    if (read.unreadable) {
      unreadable += 1;
      continue;
    }
    states += 1;
    for (const source of sourcesOf(read.state)) sources.add(source);
  }
  return { known: harnessRoot !== null || states + unreadable > 0, harnessRoot, sources, unreadable };
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

module.exports = { harnessDirFromClientName, installedComponentSources, splitByInstallation, INSTALL_HINT, PROJECT_STATE_DIRS };
