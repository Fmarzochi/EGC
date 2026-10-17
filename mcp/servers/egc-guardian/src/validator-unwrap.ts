import type { ValidationResult } from './validator-session.js';
import { SHELL_META_REGEX } from './validator-allowlists.js';
import { bareToken, stripQuotes, commandName } from './validator-tokens.js';
import { WRAPPER_SPECS, readWrapperOptions, permutedOptions, runnerCommandStart, type WrapperSpec } from './validator-wrappers.js';
import { tryUnwrapEnvAssignment, tryUnwrapExport } from './validator-env.js';
import { tokenizeWords } from './validator-shell-text.js';
import { validateCommandVerdict } from './validator.js';

export interface UnwrapResult {
  blocked?: ValidationResult;
  tokens: string[];
}

// One attempt at peeling a single leading construct off `current`. Returns
// null when this check doesn't apply (caller tries the next one); otherwise
// either `blocked` (hard-deny, unwrapping stops) or `remaining` (the new
// front of the token list to keep unwrapping from).
export interface UnwrapStep {
  blocked?: ValidationResult;
  remaining?: string[];
}

const FLOCK_COMMAND_FLAGS = new Set(['-c', '--command']);

function isSplitStringFlag(flag: string): boolean {
  return flag === '-S' || flag === '--split-string' || flag.startsWith('--split-string=');
}

function envSplitsString(current: string[], optionNames: string[]): boolean {
  return optionNames.some(isSplitStringFlag) || current.slice(1).some(t => isSplitStringFlag(stripQuotes(t)));
}

function forbiddenCommandString(reason: string): UnwrapStep {
  return { blocked: { allowed: false, reason, trust_level: 'DANGEROUS' } };
}

const RUNUSER_USER_FLAGS = new Set(['-u', '--user']);
const RUNUSER_SHELL_FLAGS = new Set(['-c', '--command', '--session-command']);

// runuser runs the words after its options only with -u/--user and without
// a command for the shell (which it refuses alongside -u); otherwise it
// behaves like su and is judged as su is.
function runuserRunsWords(current: string[], spec: WrapperSpec): boolean {
  const names = permutedOptions(current.slice(1), spec).names;
  return names.some(name => RUNUSER_USER_FLAGS.has(name)) && !names.some(name => RUNUSER_SHELL_FLAGS.has(name));
}

// `sg [-] GROUP [-c] COMMAND` hands COMMAND to `sh -c`.
function sgRunsCommand(current: string[]): boolean {
  const words = current.slice(1).map(stripQuotes);
  let k = words[0] === '-' || words[0] === '-l' ? 1 : 0;
  if (k >= words.length || words[k].startsWith('-')) return false;
  k += 1;
  return k < words.length;
}

// The command a runner runs is judged as if typed; only its denial stands,
// so a runner of something harmless keeps its own standing (`npx tsc`).
export function runnerVerdict(tokens: string[], cwd?: string): ValidationResult | null {
  const runner = runnerCommandStart(tokens.map(stripQuotes));
  if (runner === null) return null;
  if (runner.shellFlag !== null) {
    return { allowed: false, reason: `'${bareToken(tokens[0])} ${runner.shellFlag}' runs its value through a shell and is forbidden`, trust_level: 'DANGEROUS' };
  }
  const verdict = validateCommandVerdict(tokens.slice(runner.start).join(' '), cwd);
  return verdict.allowed || verdict.advisory ? null : verdict;
}

// Unwraps a known wrapper command (sudo, timeout, xargs, ...), skipping its
// flags and any mandatory leading positionals to reach the wrapped command.
function tryUnwrapWrapper(current: string[]): UnwrapStep | null {
  const head = commandName(current[0]);
  if (head === 'sg' && sgRunsCommand(current)) {
    return forbiddenCommandString(`'sg' runs its command through a shell and is forbidden`);
  }
  const spec = WRAPPER_SPECS[head];
  if (!spec) return null;
  if (head === 'runuser' && !runuserRunsWords(current, spec)) return null;

  // env -S/--split-string re-splits its value into a new argv and execs the
  // first word of that split, the same "string becomes code" shape as
  // eval, just via env(1) instead of a shell builtin. The value isn't a
  // simple opaque flag argument to skip past; it can itself be a full
  // destructive command, so this is a hard deny rather than an unwrap.
  const options = readWrapperOptions(current, spec);
  // command -v and -V only say what each name would run: nothing runs. A
  // line that goes on past them (`;`, `&&`, a pipe, a substitution) is left
  // to the chaining check below, which this command alone never reaches.
  const lookup = options.names.some(name => name === '-v' || name === '-V');
  if (head === 'command' && lookup && !current.slice(options.end).some(token => SHELL_META_REGEX.test(token))) return { remaining: [] };
  if (head === 'env' && envSplitsString(current, options.names)) {
    return forbiddenCommandString(`'env -S/--split-string' re-splits and executes its value and is forbidden`);
  }

  let i = options.end;
  let skip = spec.leadingPositionals ?? 0;
  while (skip > 0 && i < current.length && (!spec.positionalWhen || spec.positionalWhen.test(stripQuotes(current[i])))) {
    i += 1;
    skip -= 1;
  }

  // `flock FILE -c STRING` (or --command) hands STRING to a shell, the same
  // shape as env -S, so it is denied the same way.
  if (head === 'flock' && i < current.length && FLOCK_COMMAND_FLAGS.has(stripQuotes(current[i]))) {
    return forbiddenCommandString(`'flock -c/--command' runs its value through a shell and is forbidden`);
  }
  return { remaining: current.slice(i) };
}

// Peels leading environment-variable assignments and known wrapper commands
// off the front of a token list until the real command is reached, looping
// so stacked wrappers (`sudo timeout 5 xargs rm -rf`) all get unwrapped
// rather than just the outermost one.
// Shell keywords and grouping openers that stand in front of the command
// actually run: `if rm ...; then`, `then rm ...`, `(rm ...)`, `{ rm ...; }`,
// `! rm ...`. Judged as "the command", the keyword would read as a mere
// allowlist miss and let whatever follows it pass.
export const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '(']);

// `case word in pattern) command`: the command starts after the pattern.
function unwrapCaseClause(current: string[]): string[] {
  const inIndex = current.findIndex((token, index) => index > 0 && bareToken(token) === 'in');
  const rest = current.slice(inIndex === -1 ? 1 : inIndex + 1);
  return rest.length > 0 && stripQuotes(rest[0]).endsWith(')') ? rest.slice(1) : rest;
}

function isBlockOpener(token: string | undefined): boolean {
  const bare = token === undefined ? '' : stripQuotes(token);
  return bare.startsWith('{') || bare.startsWith('(');
}

// Constructs that run a command of their own: case arms, coprocesses and
// function bodies (`function f { ... }`, `f() { ... }`) are unwrapped to the
// command they carry so it is judged as if typed directly.
function tryUnwrapCommandCarrier(current: string[]): UnwrapStep | null {
  const head = bareToken(current[0]);
  if (head === 'case') return { remaining: unwrapCaseClause(current) };
  if (head === 'coproc') return { remaining: current.slice(isBlockOpener(current[2]) ? 2 : 1) };
  if (head === 'function') return { remaining: current.slice(2) };
  if (head.endsWith('()')) return { remaining: current.slice(1) };
  // A later arm of a case (`b) command`, `b ) command`) starts its own segment after ;;.
  if (head.endsWith(')')) return { remaining: current.slice(1) };
  if (current.length > 1 && bareToken(current[1]) === ')') return { remaining: current.slice(2) };
  if (current.length > 1 && bareToken(current[1]) === '()') return { remaining: current.slice(2) };
  return null;
}

function tryUnwrapShellKeyword(current: string[]): UnwrapStep | null {
  const head = bareToken(current[0]);
  if (SHELL_KEYWORDS.has(head)) return { remaining: current.slice(1) };
  if ((head.startsWith('(') || head.startsWith('{')) && head.length > 1) {
    return { remaining: [stripQuotes(current[0]).slice(1), ...current.slice(1)] };
  }
  return tryUnwrapCommandCarrier(current);
}

// The egc subcommands that run a command the caller hands them: `run` sends
// it through the Token Crusher and `verify` runs the project's verification
// command after `--`. Both execute what follows, so the wrapped command is
// judged as if it had been typed. Every other subcommand is the CLI itself
// and falls through to the ordinary allowlist handling.
const EGC_EXECUTOR_SUBCOMMANDS = new Set(['run', 'verify']);

function tryUnwrapEgcExecutor(current: string[]): UnwrapStep | null {
  if (commandName(current[0]) !== 'egc') return null;
  let i = 1;
  while (i < current.length && bareToken(current[i]).startsWith('-')) i += 1;
  if (!EGC_EXECUTOR_SUBCOMMANDS.has(bareToken(current[i] ?? ''))) return null;

  i += 1;
  let viaShell = false;
  while (i < current.length) {
    const token = bareToken(current[i]);
    if (token === '--') { i += 1; break; }
    if (!token.startsWith('-')) break;
    if (token === '--shell') viaShell = true;
    i += 1;
  }

  const rest = current.slice(i);
  if (rest.length === 0) return null;
  // --shell joins the words and hands them to a shell, so a whole script can
  // arrive as one quoted token: it is re-read as the command line it is.
  if (viaShell) return { remaining: tokenizeWords(rest.map(stripQuotes).join(' ')) };
  return { remaining: rest };
}

export function unwrapLeadingConstructs(tokens: string[], cwd?: string): UnwrapResult {
  let current = tokens;
  let changed = true;
  while (changed && current.length > 0) {
    changed = false;

    const step = tryUnwrapEnvAssignment(current, cwd) ?? tryUnwrapExport(current, cwd) ?? tryUnwrapEgcExecutor(current) ?? tryUnwrapWrapper(current) ?? tryUnwrapShellKeyword(current);
    if (step) {
      if (step.blocked) return { tokens: [], blocked: step.blocked };
      current = step.remaining as string[];
      changed = true;
    }
  }
  return { tokens: current };
}
