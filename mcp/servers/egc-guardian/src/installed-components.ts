import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mirror of scripts/lib/routing-installed.js for the Guardian server: the
// install state of the active tool says which catalog entries it can invoke.
// Home targets keep it at <harness root>/egc/install-state.json, project targets at
// <project>/<dir>/egc-install-state.json (scripts/lib/install-executor.js).
const KNOWN_HARNESS_DIRS: ReadonlyArray<ReadonlyArray<string>> = [
  ['.codeium', 'windsurf'], ['.config', 'opencode'], ['.config', 'zed'],
  ['.gemini'], ['.claude'], ['.cursor'], ['.agents'], ['.amp'], ['.continue'],
  ['.github'], ['.kiro'], ['.trae'], ['.trae-cn'], ['.codebuddy'],
];
const PROJECT_STATE_DIRS = ['.claude', '.gemini', '.cursor', '.agents', '.codex', '.github', '.kiro', '.trae', '.trae-cn', '.codebuddy', '.windsurf', '.opencode', '.zed', '.amp', '.continue'];
// Home targets write <root>/egc/install-state.json; the targets that share the .agents
// root (Codex, Goose, OpenHands) write <root>/egc/<tool>-install-state.json, so every
// state file in that directory counts.
const HOME_STATE_DIR = 'egc';
const STATE_SUFFIX = 'install-state.json';
const PROJECT_STATE = 'egc-install-state.json';

export const INSTALL_HINT = 'egc install --prompt-library (every detected tool) or egc install --target <tool> --profile full';

export interface InstalledComponents {
  known: boolean;
  harnessRoot: string | null;
  sources: Set<string>;
  unreadable: number;
}

// The same routing scripts/lib/utils.js applies to hook-time variables.
function harnessDirFromEnv(env: NodeJS.ProcessEnv, homeDir: string): string | null {
  if (env.GEMINI_PROJECT_DIR || env.GEMINI_PLUGIN_ROOT) return path.join(homeDir, '.gemini');
  if (env.CLAUDE_PROJECT_DIR || env.CLAUDE_PLUGIN_ROOT) return path.join(homeDir, '.claude');
  if (env.CODEBUDDY_PROJECT_DIR || env.CODEBUDDY_PLUGIN_ROOT) return path.join(homeDir, '.codebuddy');
  if (env.VSCODE_AGENT || env.GITHUB_COPILOT_API_TOKEN) return path.join(homeDir, '.github');
  if (env.KIRO_HOOK_FILE || env.KIRO_FILE_PATH) return path.join(homeDir, '.kiro');
  if (env.TRAE_ENV) return path.join(homeDir, env.TRAE_ENV === 'cn' ? '.trae-cn' : '.trae');
  return null;
}

type StateRead = { sources: string[] } | { unreadable: true } | null;

// A state file that is missing is simply absent; one that exists but cannot
// be read or parsed is reported as unreadable and contributes nothing, so a
// corrupt state never turns into "everything is installed".
function sourcesOf(file: string): StateRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fs.existsSync(file) ? { unreadable: true } : null;
  }
  try {
    const parsed = JSON.parse(raw) as { operations?: Array<{ sourceRelativePath?: unknown }> };
    if (!parsed || !Array.isArray(parsed.operations)) return { unreadable: true };
    return {
      sources: parsed.operations
        .map(operation => operation?.sourceRelativePath)
        .filter((source): source is string => typeof source === 'string')
        .map(source => source.split(path.sep).join('/')),
    };
  } catch {
    return { unreadable: true };
  }
}

function homeStateFiles(root: string): string[] {
  const dir = path.join(root, HOME_STATE_DIR);
  try {
    return fs.readdirSync(dir).filter(name => name.endsWith(STATE_SUFFIX)).map(name => path.join(dir, name));
  } catch {
    return [];
  }
}

// The project the tool is working in: the directory its own variable names,
// or the server's working directory when no tool names one.
function projectDirFrom(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_PROJECT_DIR || env.GEMINI_PROJECT_DIR || env.CODEBUDDY_PROJECT_DIR || process.cwd();
}

export function installedComponentSources(options: { environment?: NodeJS.ProcessEnv; cwd?: string; homeDir?: string } = {}): InstalledComponents {
  const env = options.environment ?? process.env;
  const cwd = options.cwd ?? projectDirFrom(env);
  const homeDir = options.homeDir ?? (env.HOME || env.USERPROFILE || os.homedir());
  const harnessRoot = harnessDirFromEnv(env, homeDir);
  const homeRoots = harnessRoot ? [harnessRoot] : KNOWN_HARNESS_DIRS.map(parts => path.join(homeDir, ...parts));
  const projectDirs = harnessRoot ? [path.basename(harnessRoot)] : PROJECT_STATE_DIRS;
  const files = new Set<string>();
  for (const root of homeRoots) for (const file of homeStateFiles(root)) files.add(file);
  for (const dir of projectDirs) files.add(path.join(cwd, dir, PROJECT_STATE));
  const sources = new Set<string>();
  let states = 0;
  let unreadable = 0;
  for (const file of files) {
    const found = sourcesOf(file);
    if (!found) continue;
    if ('unreadable' in found) {
      unreadable += 1;
      continue;
    }
    states += 1;
    for (const source of found.sources) sources.add(source);
  }
  return { known: states + unreadable > 0, harnessRoot, sources, unreadable };
}

// Entries without a recorded source (an older index) stay available, the
// behavior before sources were recorded.
export function splitByInstallation<T extends { source?: string }>(entries: T[], installed: InstalledComponents): { available: T[]; missing: T[] } {
  const available: T[] = [];
  const missing: T[] = [];
  for (const entry of entries) {
    if (!installed.known || !entry.source || installed.sources.has(entry.source)) available.push(entry);
    else missing.push(entry);
  }
  return { available, missing };
}
