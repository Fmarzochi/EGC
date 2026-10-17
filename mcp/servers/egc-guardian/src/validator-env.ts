import path from 'node:path';
import type { ValidationResult } from './validator-session.js';
import { bareToken, stripQuotes, commandName } from './validator-tokens.js';
import { WRAPPER_SPECS, readWrapperOptions } from './validator-wrappers.js';
import { isInlineProgram } from './validator-eval.js';
import { shellWord } from './validator-shell-text.js';
import { expandHome } from './validator-path-utils.js';
import { isTrustedGitDirectory } from './validator-hook-surfaces.js';
import { isProtectedPath } from './validator-protected-paths.js';
import { pathSpellings } from './validator-line-values.js';
import { followedGitDirectory } from './validator-git-args.js';
import type { UnwrapStep } from './validator-unwrap.js';

const ENV_ASSIGNMENT_RE = /^([A-Za-z_]\w*)=/;

// Environment variables that let a command persist or override git's hook
// and execution config the same way `-c core.hooksPath=`/`git config` does
// (see DANGEROUS_GIT_CONFIG_RULES below), but via `VAR=value git ...` on the
// command line instead — a form the old strip-and-ignore VAR= handling let
// through untouched. GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n are numbered
// (GIT_CONFIG_COUNT-driven), hence the pattern rather than a fixed name.
const DANGEROUS_ENV_VAR_EXACT = new Set([
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_EXEC_PATH',
  'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_EDITOR', 'GIT_PAGER',
  // A program git runs (a diff tool, the rebase todo editor, a password
  // prompt, a proxy), a config file it loads whole, a template it copies
  // hooks from, and the input filters of less, git's pager.
  'GIT_EXTERNAL_DIFF', 'GIT_SEQUENCE_EDITOR', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PROXY_COMMAND',
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_TEMPLATE_DIR',
  'LESSOPEN', 'LESSCLOSE', 'LESSKEY', 'LESSKEYIN', 'LESSKEY_SRC', 'LESSKEY_CONTENT',
]);
const DANGEROUS_ENV_VAR_PATTERN = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

function isDangerousEnvVarName(varName: string): boolean {
  const upper = varName.toUpperCase();
  return DANGEROUS_ENV_VAR_EXACT.has(upper)
    || DANGEROUS_ENV_VAR_PATTERN.test(upper)
    || upper.startsWith('GIT_ALIAS_');
}

// A pager or an editor may be named by itself or from the system's program
// directories; one named by another path is a script the hook never sees
// run. A pager, which git starts only on a terminal, may take plain flags;
// an editor, which git runs with none, is named alone, since any argument
// can hand it a command (vim -c) or a script (sed -f).
const PROGRAM_ENV_VARS = new Set(['PAGER', 'MANPAGER', 'EDITOR', 'VISUAL']);
const EDITOR_ENV_VARS = new Set(['EDITOR', 'VISUAL']);
const SYSTEM_PROGRAM_DIRS = ['/usr/', '/bin/', '/sbin/', '/opt/'];
const PLAIN_FLAG_RE = /^--?[A-Za-z][\w-]*(?:=[\w.,:-]*)?$/;
// A file or a directory git writes to: its trace, its index, its objects.
const GIT_PATH_ENV_VAR_RE = /^GIT_(?:TRACE\w*|INDEX_FILE|WORK_TREE|OBJECT_DIRECTORY)$/;
// The repository git reads its config and hooks from: a .git or <name>.git
// directory, whose config is protected (isTrustedGitDirectory, the rule
// --git-dir and the directory git finds are held to), and no other.
const REPOSITORY_ENV_VARS = new Set(['GIT_DIR', 'GIT_COMMON_DIR']);
// Where git and gpg, which git runs to sign, find their config, which can
// name commands they run.
const CONFIG_HOME_ENV_VARS = new Set(['HOME', 'XDG_CONFIG_HOME', 'GNUPGHOME']);
const CONFIG_HOME_COMMANDS = new Set(['git', 'gpg', 'gpg2']);
// less options that hand it an initial command or a key file.
const LESS_COMMAND_RE = /\+|--lesskey|(?:^|\s)-?[A-Za-z]*k/;
// The man option (git help runs man) that renders HTML and launches a
// browser this line names: -H, -Hbrowser or --html[=browser].
const MANOPT_COMMAND_RE = /(?:^|\s)-[A-Za-z]*H|--html/;

// A program in a system directory, its path resolved first so a `..` cannot
// climb back out of one (`/usr/bin/../../tmp/evil.sh`).
function inSystemDirectory(program: string): boolean {
  const resolved = program.startsWith('/') ? path.posix.normalize(program) : program;
  return SYSTEM_PROGRAM_DIRS.some(dir => resolved.startsWith(dir));
}

function programValueDenied(text: string, alone: boolean): boolean {
  const words = text.trim().split(/\s+/);
  const program = words[0] ?? '';
  const byPath = program.includes('/') && !inSystemDirectory(program);
  const args = words.slice(1);
  return isInlineProgram(text) || byPath || (alone ? args.length > 0 : args.some(arg => !PLAIN_FLAG_RE.test(arg)));
}

// Why the value a line gives a variable is refused: a path git writes that
// is protected, a config home for the git command it prefixes, less options
// that run a command, or a pager or an editor that is inline code, a script
// named by its path or a program handed an argument. null when it is free.
function envValueDenial(name: string, value: string, command: string | undefined, persists: boolean, cwd?: string): string | null {
  const upper = name.toUpperCase();
  const text = stripQuotes(value);
  const spellings = pathSpellings(shellWord(value));
  const written = GIT_PATH_ENV_VAR_RE.test(upper) ? spellings.find(p => isProtectedPath(p)) : undefined;
  if (written !== undefined) {
    return `'${name}' makes git write to the protected path ${written}, which is forbidden`;
  }
  // Read from where the command runs, so a relative link is followed there.
  const untrusted = REPOSITORY_ENV_VARS.has(upper)
    ? spellings.find(p => !isTrustedGitDirectory(followedGitDirectory(path.resolve(cwd ?? process.cwd(), expandHome(p)))))
    : undefined;
  if (untrusted !== undefined) {
    return `'${name}' points git at ${untrusted}, a repository whose config this line can choose, which is forbidden: name a .git or <name>.git directory`;
  }
  // When it persists (export, a bare assignment) it holds for the git
  // commands later on the line; git's own programs (git-upload-pack) read
  // the same config; a wrapper (env, nice) passes it to the git it runs.
  if (CONFIG_HOME_ENV_VARS.has(upper) && (persists || command === 'git' || CONFIG_HOME_COMMANDS.has(command ?? '') || (command ?? '').startsWith('git-'))) {
    return `'${name}' points git or gpg at a config this line chooses, which can name commands they run, and is forbidden`;
  }
  if (upper === 'LESS' && LESS_COMMAND_RE.test(text)) {
    return `'LESS' hands less an initial command or a key file, which is forbidden`;
  }
  if (upper === 'MANOPT' && MANOPT_COMMAND_RE.test(text)) {
    return `'MANOPT' makes man render HTML and launch a browser this line names, which is forbidden`;
  }
  if (PROGRAM_ENV_VARS.has(upper) && programValueDenied(text, EDITOR_ENV_VARS.has(upper))) {
    return `'${name}' is run as a pager or an editor, and '${text}' is inline code, a script named by its path or a program handed an argument, which is forbidden: name the program itself`;
  }
  return null;
}

// Code a shell sources before the script it runs, which the hook never
// reads, libraries the loader puts into a program before it starts, and the
// startup commands and files an editor git runs reads first.
const CODE_INJECTION_ENV_VARS = new Set([
  'BASH_ENV', 'ENV', 'LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES',
  'VIMINIT', 'EXINIT', 'GVIMINIT', 'VIM', 'VIMRUNTIME', 'EMACSLOADPATH',
]);

// The command a line runs once its known wrappers (env, nice, nohup, sudo,
// timeout, ...) are peeled off, so a config home that reaches git or gpg
// through one of them is judged as a direct call is. undefined when nothing
// but wrappers is left.
function commandThroughWrappers(tokens: string[]): string | undefined {
  let current = tokens;
  for (let depth = 0; depth < 16 && current.length > 0; depth += 1) {
    const head = commandName(current[0]);
    const spec = WRAPPER_SPECS[head];
    if (!spec) return head;
    const { end } = readWrapperOptions(current, spec);
    current = current.slice(end + (spec.leadingPositionals ?? 0));
  }
  return current.length > 0 ? commandName(current[0]) : undefined;
}

// The block a `VAR=value` or `export VAR=value` gets, if any; `command` is
// the command the assignment prefixes, when there is one.
function envAssignmentBlock(name: string, value: string, verb: string, command: string | undefined, persists: boolean, cwd?: string): ValidationResult | null {
  if (isDangerousEnvVarName(name)) {
    return { allowed: false, reason: `${verb} '${name}' persists a git execution/config override and is forbidden`, trust_level: 'DANGEROUS' };
  }
  if (CODE_INJECTION_ENV_VARS.has(name.toUpperCase())) {
    return { allowed: false, reason: `${verb} '${name}' makes the next program run code this line chooses before its own (a startup script or a library), which is forbidden`, trust_level: 'DANGEROUS' };
  }
  const reason = envValueDenial(name, value, command, persists, cwd);
  return reason ? { allowed: false, reason, trust_level: 'DANGEROUS' } : null;
}

// A bare `VAR=value` prefix persists in the shell's environment for every
// command that follows, so a dangerous git-persistence variable here is a
// hard block rather than a silent strip: stripping it would judge the
// command by a name that never actually ran with that override in effect.
export function tryUnwrapEnvAssignment(current: string[], cwd?: string): UnwrapStep | null {
  const envMatch = ENV_ASSIGNMENT_RE.exec(current[0]);
  if (!envMatch) return null;
  let start = 0;
  while (start < current.length && ENV_ASSIGNMENT_RE.test(current[start])) start += 1;
  const rest = current.slice(start);
  const command = commandThroughWrappers(rest);
  const blocked = envAssignmentBlock(envMatch[1], current[0].slice(envMatch[0].length), 'setting', command, rest.length === 0, cwd);
  return blocked ? { blocked } : { remaining: current.slice(1) };
}

// `export VAR=value` persists the same way a bare `VAR=value` prefix does
// (the shell keeps it in the environment for every command that follows in
// this session/segment chain, not just the current one), so it gets the
// identical dangerous-name check rather than being treated as an unknown,
// advisory-only 'export' command. `export` accepts its own options (-f, -n,
// -p) and a `--` end-of-options marker before the assignment, same as any
// other bash builtin — skipping straight to current[1] missed
// `export -- GIT_SSH_COMMAND=...`, which real bash still treats as an
// assignment despite the leading `--`.
export function tryUnwrapExport(current: string[], cwd?: string): UnwrapStep | null {
  if (bareToken(current[0]) !== 'export' || current.length <= 1) return null;

  let idx = 1;
  while (idx < current.length) {
    const flagToken = stripQuotes(current[idx]);
    if (flagToken === '--') { idx += 1; break; }
    if (!flagToken.startsWith('-')) break;
    idx += 1;
  }
  // export removes the quotes around its argument before it reads the
  // assignment, so `export "BASH_ENV=x"` sets BASH_ENV as the bare form does.
  const assignment = idx < current.length ? stripQuotes(current[idx]) : '';
  const exportMatch = ENV_ASSIGNMENT_RE.exec(assignment);
  if (!exportMatch) return null;

  const blocked = envAssignmentBlock(exportMatch[1], assignment.slice(exportMatch[0].length), 'exporting', undefined, true, cwd);
  return blocked ? { blocked } : { remaining: current.slice(idx + 1) };
}
