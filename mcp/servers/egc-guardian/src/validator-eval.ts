import { flagsInCommittedScript, type ValidationResult } from './validator-session.js';
import { bareToken, stripQuotes, commandName } from './validator-tokens.js';
import { WRAPPER_SPECS, permutedOptions } from './validator-wrappers.js';

// Interpreters/shells whose inline-eval flags let an agent execute arbitrary
// code that bypasses every path- and content-based check in this file (the
// interpreter reads/writes/execs whatever the inline string tells it to,
// independent of the guardian's allowlist for base commands). Denied
// regardless of whether the interpreter itself is otherwise allowlisted,
// because 'allowed to run node' must not imply 'allowed to eval anything'.
// Matches an eval flag given exactly, glued to its value (-e'code', -ccode),
// or joined with = or : (--eval=code, -Command:code). Exact membership alone
// misses every glued form, which the underlying interpreters all accept.
// Interpreters whose single-dash options are long words (-NonInteractive,
// -Command): a letter inside one of those is not a combined short flag.
const POWERSHELL_NAMES = new Set(['pwsh', 'powershell', 'powershell.exe', 'pwsh.exe']);
const NO_SHORT_FLAG_CLUSTERS = POWERSHELL_NAMES;
const SHORT_FLAG_CLUSTER = /^-[A-Za-z]+$/;

// `arg` is the lowercased token the exact and glued comparisons always used;
// `casedArg` keeps the letter case, because inside a cluster -c and -C are
// different options (bash -xC is noclobber, not eval), so the cluster check
// must not inherit the lowercasing. Pass null to skip the cluster check.
export function matchesEvalFlag(arg: string, flags: string[], casedArg: string | null): boolean {
  for (const flag of flags) {
    if (arg === flag) return true;
    if (arg.startsWith(flag + '=') || arg.startsWith(flag + ':')) return true;
    if (flag.startsWith('--') || flag.length !== 2) continue;
    if (arg.startsWith(flag) && arg.length > 2) return true;
    // getopt-style interpreters accept combined short options, so the eval
    // letter anywhere in a pure letter cluster (-xc, -lc, -Bc, -pe, -ne)
    // still switches on eval. Matching only the exact token or the glued
    // value form let `bash -xc "..."` through with no warning at all.
    if (casedArg !== null && SHORT_FLAG_CLUSTER.test(casedArg) && casedArg.includes(flag[1])) return true;
  }
  return false;
}

// PowerShell reads a parameter from any prefix of its name, given with -,
// -- or /, its value glued on after a colon: -Command, -EncodedCommand (and
// its aliases -e and -ec) and -CommandWithArgs (-cwa) run the code they
// carry. -ExecutionPolicy (-ex) and -ConfigurationName (-con) do not.
function isPowerShellEvalFlag(word: string): boolean {
  const match = /^(?:--?|\/)([a-z]+)(?::|$)/i.exec(word);
  if (!match) return false;
  const name = match[1].toLowerCase();
  if (name === 'e' || name === 'ec' || name === 'cwa') return true;
  return 'command'.startsWith(name) || (name.length >= 2 && 'encodedcommand'.startsWith(name)) || (name.length > 7 && 'commandwithargs'.startsWith(name));
}

// php's options that run code, by case (-e only turns on debug information):
// alone, with the code glued on, or last in a group of short options.
const PHP_CODE_FLAGS = ['r', 'B', 'R', 'E'];
const PHP_CODE_LONG_FLAGS = ['--process-begin', '--process-code', '--process-end'];

function isPhpCodeFlag(word: string): boolean {
  if (word.startsWith('--')) return PHP_CODE_LONG_FLAGS.some(flag => word === flag || word.startsWith(`${flag}=`));
  return /^-[a-zA-Z]/.test(word) && PHP_CODE_FLAGS.some(flag => word[1] === flag || (SHORT_FLAG_CLUSTER.test(word) && word.includes(flag)));
}

// A subcommand of an interpreter that runs the code given to it, and the
// options before it that take the next word as their value.
const EVAL_SUBCOMMANDS: Record<string, string> = { deno: 'eval' };
const EVAL_SUBCOMMAND_VALUE_OPTIONS: Record<string, Set<string>> = {
  deno: new Set(['-c', '--config', '-L', '--log-level', '--import-map', '--lock', '--cert', '--location', '--seed']),
};

// The first word that is neither an option nor an option's value.
function subcommandOf(evalName: string, words: string[]): string | undefined {
  const valueOptions = EVAL_SUBCOMMAND_VALUE_OPTIONS[evalName];
  for (let i = 0; i < words.length; i += 1) {
    if (!words[i].startsWith('-')) return words[i];
    if (valueOptions?.has(words[i])) i += 1;
  }
  return undefined;
}

function runsGivenCode(evalName: string, args: string[]): boolean {
  const words = args.map(stripQuotes);
  if (POWERSHELL_NAMES.has(evalName) && words.some(isPowerShellEvalFlag)) return true;
  if (evalName === 'php' && words.some(isPhpCodeFlag)) return true;
  const subcommand = EVAL_SUBCOMMANDS[evalName];
  return subcommand !== undefined && subcommandOf(evalName, words) === subcommand;
}

export function inlineEvalVerdict(baseCommand: string, args: string[]): ValidationResult | null {
  const evalName = INLINE_EVAL_COMMANDS[baseCommand] ? baseCommand : bareInterpreterName(baseCommand);
  // PowerShell's parameters are read by name (isPowerShellEvalFlag): a glued
  // short-flag match would take -ConfigurationName for -c.
  const evalFlags = POWERSHELL_NAMES.has(evalName) ? undefined : INLINE_EVAL_COMMANDS[evalName];
  const clusters = !NO_SHORT_FLAG_CLUSTERS.has(evalName);
  const abbreviates = ABBREVIATING_EVAL_COMMANDS.has(evalName);
  const isEvalFlag = (a: string, flags: string[]): boolean =>
    matchesEvalFlag(bareToken(a), flags, clusters ? stripQuotes(a) : null) || (abbreviates && abbreviatesEvalFlag(bareToken(a), flags));
  if ((evalFlags && args.some(a => isEvalFlag(a, evalFlags))) || runsGivenCode(evalName, args)) {
    const denial: ValidationResult = {
      allowed: false,
      reason: `inline code execution via '${baseCommand}' eval flag is forbidden — write the code to a file and run it instead`,
      trust_level: 'DANGEROUS',
    };
    if (HANDOFF_EVAL_COMMANDS.has(evalName) || !flagsInCommittedScript(denial)) return denial;
  }
  return suShellOperandsVerdict(evalName, args);
}

// su, runuser and script read long options with getopt_long, which takes any
// prefix of `--command` (`--comm`) as the option itself.
const ABBREVIATING_EVAL_COMMANDS = new Set(['su', 'runuser', 'script']);
// They also run the code they are given as another user or through a
// terminal of their own, which nothing reads back out of: even in a
// committed script their -c stays a denial.
const HANDOFF_EVAL_COMMANDS = ABBREVIATING_EVAL_COMMANDS;

function abbreviatesEvalFlag(arg: string, flags: string[]): boolean {
  if (!arg.startsWith('--')) return false;
  const name = arg.split('=')[0];
  return name.length > 2 && flags.some(flag => flag.startsWith('--') && flag.startsWith(name));
}

// su, and runuser without -u, hand every word after the user to that user's
// shell as its arguments: a script to run, or `-c` and a command.
function suShellOperandsVerdict(baseCommand: string, args: string[]): ValidationResult | null {
  if (baseCommand !== 'su' && baseCommand !== 'runuser') return null;
  const operands = permutedOptions(args, WRAPPER_SPECS.runuser).operands;
  const afterLogin = operands[0] === '-' ? operands.slice(1) : operands;
  if (afterLogin.length < 2) return null;
  return {
    allowed: false,
    reason: `'${baseCommand}' hands the words after the user to that user's shell, which runs them; run the command directly instead`,
    trust_level: 'DANGEROUS',
  };
}

// Strip a trailing version suffix (python3.11 -> python) so a versioned
// interpreter binary resolves to the same inline-eval rule as its bare name.
// Linear scan rather than a regex to keep this off any backtracking path.
export function bareInterpreterName(name: string): string {
  let end = name.length;
  while (end > 0 && (name[end - 1] === '.' || (name[end - 1] >= '0' && name[end - 1] <= '9'))) {
    end -= 1;
  }
  return name.slice(0, end);
}

export const INLINE_EVAL_COMMANDS: Record<string, string[]> = {
  node: ['-e', '--eval', '-p', '--print'],
  nodejs: ['-e', '--eval', '-p', '--print'],
  python: ['-c'],
  python2: ['-c'],
  python3: ['-c'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
  bun: ['-e', '--eval', '-p', '--print'],
  deno: ['--eval'],
  bash: ['-c'],
  sh: ['-c'],
  zsh: ['-c'],
  dash: ['-c'],
  ksh: ['-c'],
  // su -c runs its whole argument as a shell command under another user,
  // same risk class as `bash -c` — unlike sudo/doas, su has no separate
  // "unwrap the next token as the real command" shape (the command is one
  // string argument to -c), so it is handled here instead of WRAPPER_SPECS.
  su: ['-c', '--command', '--session-command'],
  runuser: ['-c', '--command', '--session-command'],
  script: ['-c', '--command'],
  pwsh: ['-c', '-command', '-Command'],
  powershell: ['-c', '-command', '-Command'],
  'powershell.exe': ['-c', '-command', '-Command'],
};

// Shells that read the rest of their input as a script: named alone as the
// command git runs, they run whatever the stream or the path it is given holds.
export const GIT_VALUE_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'busybox', 'pwsh', 'powershell']);
const SHELL_SYNTAX_RE = /[|&;<>`$()\n]/;

// Whether a command a shell reads has shell syntax outside the quotes that
// keep it text: single quotes keep everything, double quotes all but `$`
// and a backquote, and a backslash the character after it. A quote left
// open counts, since the shell would read on past it.
function hasShellSyntax(text: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (isLiveShellChar(ch, quote)) return true;
    if (ch === '"' || ch === "'") quote = quote === ch ? null : (quote ?? ch);
  }
  return quote !== null;
}

// Inside double quotes only `$` and a backquote still act; outside, any
// shell syntax does.
function isLiveShellChar(ch: string, quote: string | null): boolean {
  return quote === '"' ? ch === '$' || ch === '`' : SHELL_SYNTAX_RE.test(ch);
}

// A command another tool runs (a git option, a sed e, an ag --pager, an rg
// --pre) is inline code when it has shell syntax, names a shell, or names an
// interpreter alone, which then reads its program from what it is handed.
export function isInlineProgram(value: string): boolean {
  const words = value.trim().split(/\s+/);
  const program = commandName(words[0] ?? '');
  if (hasShellSyntax(value) || GIT_VALUE_SHELLS.has(program)) return true;
  return words.length === 1 && Object.hasOwn(INLINE_EVAL_COMMANDS, bareInterpreterName(program));
}
