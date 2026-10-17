import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { foldCase, expandHome, resolveRealOrLexical } from './validator-path-utils.js';

// The paths of a git directory that decide what git runs: its config (the
// repo-local counterpart of ~/.gitconfig, which can carry every key
// checkGitConfigWrite denies through the CLI), config.worktree, commondir
// (which names the directory whose config git loads) and any hook, which
// fires on the next matching git operation without a config change at
// all. The directory itself, and the ones it keeps for linked work trees
// (worktrees/) and submodules (modules/, which may nest), are protected
// whole: a directory copied, synced or linked there brings a config of its
// own.
const GIT_CONTROL_FILES = new Set(['config', 'config.worktree', 'commondir']);
const GIT_CONTROL_DIRS = new Set(['hooks', 'worktrees', 'modules']);

function isGitControlPath(rest: string[], regularFile: boolean): boolean {
  if (rest.length === 0) return !regularFile;
  if (GIT_CONTROL_DIRS.has(rest[0])) return true;
  return rest.length === 1 && GIT_CONTROL_FILES.has(rest[0]);
}

// The directories a repository conventionally points core.hooksPath at: git
// runs what they hold as it runs .git/hooks, so they are written as it is.
const HOOK_DIRECTORY_NAMES = new Set(['.githooks', '.husky']);

// The hook surfaces of the tools EGC installs into: the configuration a tool
// reads its hooks from, and the directories EGC installs its hook scripts and
// the libraries they load into. A tool runs what it finds there on its next
// session without anyone reading it first, so they are written as .git/hooks
// is: by the person and the installer, never by the agent. Reading them
// stays free. Every pattern is rooted in a tool's own directory, in the home
// or in a project, so a repository's own scripts/hooks or hooks/hooks.json
// is a source tree and stays writable; the Cursor and Kiro files a
// repository keeps for those tools are the one exception, since the tools
// run them from there.
const TOOL_HOOK_SURFACE_PATTERNS: RegExp[] = [
  // Claude Code, in the home and in a project, with the .claude/hooks
  // directory its documentation keeps the hook scripts in, and CodeBuddy and
  // Qwen Code, whose project settings.json carries hooks of the same shape.
  /(^|[\\/])\.claude[\\/]settings(\.local)?\.json$/,
  /(^|[\\/])\.claude[\\/]hooks([\\/]|$)/,
  /(^|[\\/])\.(codebuddy|qwen)[\\/]settings\.json$/,
  // hooks.json: Codex, Antigravity (the shared config/, the CLI's own
  // directory, and the hooks/ the retired Gemini CLI read), the project
  // .agents/, Cursor, Copilot, Devin Desktop (the home directory, .windsurf
  // and .devin, where Devin Local also reads hooks.v1.json), Trae and
  // OpenHands (project and home).
  /(^|[\\/])\.codex[\\/]hooks\.json$/,
  /(^|[\\/])\.gemini[\\/](config|antigravity-cli|hooks)[\\/]hooks\.json$/,
  /(^|[\\/])\.agents[\\/]hooks\.json$/,
  /(^|[\\/])\.cursor[\\/]hooks\.json$/,
  /(^|[\\/])\.copilot[\\/]hooks[\\/]hooks\.json$/,
  /(^|[\\/])(\.codeium[\\/]windsurf|\.windsurf|\.devin)[\\/]hooks(\.v1)?\.json$/,
  /(^|[\\/])\.trae[\\/]hooks\.json$/,
  /(^|[\\/])\.openhands[\\/]hooks\.json$/,
  // Devin Local's user config (~/.config/devin, %APPDATA%\devin) and its
  // project override both carry PreToolUse hooks.
  /(^|[\\/])(\.config|appdata[\\/]roaming)[\\/]devin[\\/]config\.json$/,
  /(^|[\\/])\.devin[\\/]config\.local\.json$/,
  // Kiro: the CLI reads hooks from each agent file, the IDE from its panel.
  /(^|[\\/])\.kiro[\\/]agents[\\/][^\\/]+\.json$/,
  /(^|[\\/])\.kiro[\\/]hooks([\\/]|$)/,
  // Cline runs the files of .clinerules/hooks as its hooks.
  /(^|[\\/])\.clinerules[\\/]hooks([\\/]|$)/,
  // Junie reads ~/.junie/config.json; Crush reads a crush.json or .crush.json
  // from the directory it runs in and from its config directory
  // (~/.config/crush, $XDG_CONFIG_HOME/crush or $CRUSH_GLOBAL_CONFIG), so the
  // file is known by its name wherever it is.
  /(^|[\\/])\.junie[\\/]config\.json$/,
  /(^|[\\/])\.?crush\.json$/,
  // OpenCode and Amp load every file of the plugin directories EGC installs
  // into (a project's own .opencode is a source tree, as the EGC repository's
  // is); the Goose plugin EGC installs is a self-contained root of hooks and
  // scripts.
  /(^|[\\/])\.config[\\/]opencode[\\/]plugins?([\\/]|$)/,
  /(^|[\\/])(\.config[\\/]amp|\.amp)[\\/]plugins([\\/]|$)/,
  /(^|[\\/])\.agents[\\/]plugins[\\/]egc-guardian([\\/]|$)/,
  // Cursor runs its hook scripts from .cursor/hooks.
  /(^|[\\/])\.cursor[\\/]hooks([\\/]|$)/,
];

// The roots the installers copy the hook scripts and their libraries under:
// a tool's own directory, named by one segment, or by two for the tools
// that live under ~/.codeium or ~/.config.
const TOOL_ROOT_NAMES = new Set([
  '.claude', '.gemini', '.agents', '.codex', '.copilot', '.junie', '.kiro', '.amp', '.trae', '.cursor',
  '.clinerules', '.windsurf', '.devin', '.codebuddy', '.qwen', '.openhands', '.kimi-code',
]);
const TOOL_ROOT_PAIRS = new Map<string, Set<string>>([
  ['.codeium', new Set(['windsurf'])],
  ['.config', new Set(['opencode', 'crush', 'amp', 'zed', 'devin'])],
]);
// Under such a root, the directories that hold what the hooks run.
const INSTALLED_HOOK_DIRECTORIES: ReadonlyArray<readonly [string, string]> = [
  ['scripts', 'hooks'], ['scripts', 'lib'], ['egc', 'hooks'], ['egc', 'lib'],
];

// Whether the path lies in a directory EGC installs hook scripts into, under
// one of the tool roots above; a repository's own scripts/hooks has no such
// root above it and is left alone.
function isInstalledHookScriptPath(parts: string[]): boolean {
  for (let i = 0; i < parts.length; i += 1) {
    let next = -1;
    if (TOOL_ROOT_NAMES.has(parts[i])) next = i + 1;
    else if (TOOL_ROOT_PAIRS.get(parts[i])?.has(parts[i + 1] ?? '')) next = i + 2;
    if (next < 0) continue;
    if (INSTALLED_HOOK_DIRECTORIES.some(([first, second]) => parts[next] === first && parts[next + 1] === second)) return true;
  }
  return false;
}

function matchesToolHookSurface(candidate: string): boolean {
  return TOOL_HOOK_SURFACE_PATTERNS.some(pattern => pattern.test(candidate)) || isInstalledHookScriptPath(candidate.split(/[\\/]/));
}

// Whether the path is a hook surface of a tool (see TOOL_HOOK_SURFACE_PATTERNS),
// judged by its name as well as by where it really is: a link inside
// ~/.claude/scripts/hooks still names the file the tool runs, wherever the
// link leads, and a ~/.claude that is itself a link elsewhere is still where
// the tool reads its hooks.
export function isToolHookSurface(p: string, baseDir: string = process.cwd()): boolean {
  const lexical = path.resolve(baseDir, expandHome(p.trim()));
  return matchesToolHookSurface(foldCase(lexical)) || matchesToolHookSurface(foldCase(resolveRealOrLexical(lexical)));
}

// A git directory is one named `.git` or `<name>.git`: only there are its
// control files protected from a write, whatever repository they belong to.
// A path so named is one, or may become one, unless it is a regular file
// already (`regularFile`): writing that makes no git directory.
export function isGitControlFile(candidate: string, regularFile = false): boolean {
  const parts = candidate.split(/[\\/]/);
  return parts.some((part, i) => HOOK_DIRECTORY_NAMES.has(part) || (part.endsWith('.git') && isGitControlPath(parts.slice(i + 1), regularFile)));
}

// core.hooksPath as one config file sets it, the last setting winning; a
// value after `#` or `;` is a comment. Include files are not followed.
function hooksPathOf(configFile: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch {
    return null;
  }
  let inCore = false;
  let value: string | null = null;
  for (const raw of configLines(text)) {
    let line = raw.trim();
    if (line.startsWith('[')) {
      const close = line.indexOf(']');
      inCore = (close < 0 ? line.slice(1) : line.slice(1, close)).trim().split(/[\s"]/)[0].toLowerCase() === 'core';
      // A variable may follow the section header on its line.
      line = close < 0 ? '' : line.slice(close + 1).trim();
    }
    const entry = inCore ? configValue(line, 'hookspath') : null;
    if (entry !== null) value = entry;
  }
  return value || null;
}

// A config file's lines, a line ending in an unescaped backslash joined to
// the next, as git continues a value there.
function configLines(text: string): string[] {
  const lines: string[] = [];
  let pending = '';
  for (const raw of text.split(/\r?\n/)) {
    let end = raw.length;
    while (end > 0 && raw[end - 1] === '\\') end -= 1;
    const continued = (raw.length - end) % 2 === 1;
    pending += continued ? raw.slice(0, -1) : raw;
    if (continued) continue;
    lines.push(pending);
    pending = '';
  }
  if (pending) lines.push(pending);
  return lines;
}

const CONFIG_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', t: '\t', b: '\b' };

// The value a `name = value` config line sets, when it sets `name`, read as
// git reads it: quotes removed, escapes resolved, a `#` or `;` outside
// quotes starting a comment.
function configValue(line: string, name: string): string | null {
  const eq = line.indexOf('=');
  if (eq < 0 || line.slice(0, eq).trim().toLowerCase() !== name) return null;
  const raw = line.slice(eq + 1).trim();
  let value = '';
  let quoted = false;
  for (let k = 0; k < raw.length; k += 1) {
    const ch = raw[k];
    if (ch === '\\' && k + 1 < raw.length) {
      value += CONFIG_ESCAPES[raw[k + 1]] ?? raw[k + 1];
      k += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && (ch === '#' || ch === ';')) {
      break;
    } else {
      value += ch;
    }
  }
  return value.trim();
}

// The config a `.git` entry leads to: a directory's own, or, for the file a
// linked work tree or a submodule keeps there, the one of the git directory
// it names (through its commondir, when it has one).
function gitDirectoryConfig(dotGit: string): string | null {
  try {
    if (fs.statSync(dotGit).isDirectory()) return path.join(dotGit, 'config');
    const pointer = fs.readFileSync(dotGit, 'utf8').split(/\r?\n/).find(line => line.startsWith('gitdir:'));
    if (pointer === undefined) return null;
    const gitDir = path.resolve(path.dirname(dotGit), pointer.slice('gitdir:'.length).trim());
    let commonDir = gitDir;
    try {
      commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    } catch {
      // no commondir: the git directory is its own
    }
    return path.join(commonDir, 'config');
  } catch {
    return null;
  }
}

function repositoryOf(start: string): { root: string; config: string } | null {
  let dir = start;
  for (;;) {
    const config = gitDirectoryConfig(path.join(dir, '.git'));
    if (config !== null) return { root: dir, config };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Where git reads core.hooksPath when the repository does not set it, the
// first one that does winning.
function globalGitConfigs(): string[] {
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
  return [path.join(home, '.gitconfig'), path.join(xdg, 'git', 'config'), '/etc/gitconfig'];
}

// The names git runs a hook by (githooks(5)).
const GIT_HOOK_NAMES = new Set([
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
  'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit',
  'post-index-change',
]);

// The directories core.hooksPath points git at for a file in `dir`: the
// repository's own setting, and the user's, which every repository without
// one of its own follows. A relative value is taken from the top of the
// work tree, so it only counts inside a repository.
function configuredHooksDirectories(dir: string): string[] {
  const repository = repositoryOf(dir);
  const own = repository === null ? null : hooksPathOf(repository.config);
  const user = globalGitConfigs().map(hooksPathOf).find(value => value !== null) ?? null;
  const directories: string[] = [];
  for (const value of [own, user]) {
    const expanded = value === null ? null : expandHome(value);
    if (expanded !== null && path.isAbsolute(expanded)) directories.push(expanded);
    else if (expanded !== null && repository !== null) directories.push(path.resolve(repository.root, expanded));
  }
  return directories;
}

// Whether the path is a hook git runs from a directory core.hooksPath points
// at, for the repository holding the path or the one the command runs in
// (its setting may point outside it). That directory may hold other files
// too (it can be the work tree itself), so there only the hooks are written
// as .git/hooks is.
export function isConfiguredHook(normalizedP: string, baseDir: string): boolean {
  if (!GIT_HOOK_NAMES.has(foldCase(path.basename(normalizedP)))) return false;
  const dir = foldCase(path.dirname(normalizedP));
  const directories = [...configuredHooksDirectories(path.dirname(normalizedP)), ...configuredHooksDirectories(path.resolve(baseDir))];
  return directories.some(hooks => foldCase(resolveRealOrLexical(hooks)) === dir);
}

export function isRegularFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

// Whether git may use `dir` as its git directory: its config is protected
// from a write, and wherever it is, so are its hooks, so nothing planted
// there runs. Where it really is counts as well as how it is named: a link
// named x.git to another directory leads git to that directory's config.
export function isTrustedGitDirectory(dir: string): boolean {
  const protectedConfig = (place: string) => isGitControlFile(path.join(foldCase(place), 'config'));
  return protectedConfig(dir) && protectedConfig(resolveRealOrLexical(path.resolve(dir)));
}
